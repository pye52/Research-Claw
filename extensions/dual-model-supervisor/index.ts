/**
 * Dual Model Supervisor — Plugin Entry Point
 *
 * Registers 7 hooks + 6 RPC methods for dual-model supervision:
 *   - Safety filtering (message_sending, before_tool_call)
 *   - Course correction (llm_output → session analysis, before_prompt_build, llm_input → consistency check → enqueueBlock)
 *   - Memory guarding (before_compaction, after_compaction)
 *   - Audit logging (SQLite)
 *   - Dashboard RPC (rc.supervisor.*)
 *
 * Per-turn `TurnState` (see `src/core/turn-context.ts`) isolates concurrent
 * user messages. Session-level research anchors + append-only lists live in
 * `SessionAnchorsRegistry` and merge at `message_sending`. Compaction snapshots
 * use `CompactionEventRegistry` (see `src/core/compaction-event.ts`).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import type {
  PluginApi,
  PluginDefinition,
  SupervisorConfig,
  TurnState,
  ModelsProviderEntry,
  ConfiguredProvider,
  GatekeeperResult,
} from './src/core/types.js';
import { parseConfig, isSupervisorActive, isCourseCorrectionActive } from './src/core/config.js';
import { ReviewerClient } from './src/client/reviewer.js';
import { QuickChecker } from './src/hooks/quick-checker.js';
import { OutputReviewer } from './src/hooks/output-reviewer.js';
import { ToolReviewer } from './src/hooks/tool-reviewer.js';
import { MemoryGuardian } from './src/hooks/memory-guardian.js';
import { CourseCorrector } from './src/hooks/course-corrector.js';
import { ConsistencyChecker } from './src/hooks/consistency-checker.js';
import { GoalParser } from './src/hooks/goal-parser.js';
import { SummaryExtractor } from './src/hooks/summary-extractor.js';
import { PreReviewFilter } from './src/hooks/pre-review-filter.js';
import { AuditLogService } from './src/core/audit-log.js';
import { GATEKEEPER_SYSTEM_PROMPT } from './src/core/prompts.js';
import { registerSupervisorRpc } from './src/rpc.js';
import { snapshotMessageSendingCtx, SUPERVISOR_REVIEW_SUMMARY_MARKER } from './src/hooks/hook-context.js';
import {
  TurnRegistry,
  turnStore,
  resolveTurn,
  extractLastUserMessageText,
} from './src/core/turn-context.js';
import { SessionAnchorsRegistry } from './src/core/session-anchors.js';
import { CompactionEventRegistry } from './src/core/compaction-event.js';

// ── Module-level state (survives multiple register() calls) ──────────
let _initialized = false;
let _db: Database.Database | null = null;
let _auditLog: AuditLogService | null = null;
let _reviewerClient: ReviewerClient | null = null;
let _quickChecker: QuickChecker | null = null;
let _outputReviewer: OutputReviewer | null = null;
let _toolReviewer: ToolReviewer | null = null;
let _memoryGuardian: MemoryGuardian | null = null;
let _courseCorrector: CourseCorrector | null = null;
let _consistencyChecker: ConsistencyChecker | null = null;
let _goalParser: GoalParser | null = null;
let _summaryExtractor: SummaryExtractor | null = null;
let _preReviewFilter: PreReviewFilter | null = null;
let _activeConfig: SupervisorConfig | null = null;

/** OpenClaw `message_received` often omits `sessionId`; we mirror it from the latest `session_start`. */
let _hookActiveSessionId: string | null = null;

const _registry = new TurnRegistry();
const _anchors = new SessionAnchorsRegistry();
const _compactions = new CompactionEventRegistry();

const DEFAULT_DB_PATH = path.join(os.homedir(), '.research-claw', 'supervisor.db');

/**
 * Gate static supervisor rules: OpenClaw may call `before_prompt_build` several times per user turn;
 * each return value is concatenated, which previously duplicated this block 2–3×.
 */
let _lastStaticSupervisorInjectAt = 0;
const STATIC_SUPERVISOR_DEBOUNCE_MS = 1500;

const STATIC_SUPERVISOR_RULES_BODY = [
  '[Supervisor] You are under dual-model supervision. Follow these rules:',
  '  - Do NOT fabricate citations, data, or experimental results',
  '  - Do NOT deviate from the current research topic',
  '  - If you have forgotten key information discussed earlier, explicitly state: "I may have lost context, please remind me"',
].join('\n');

function takeStaticSupervisorRulesBlock(reviewMode: string): string {
  if (reviewMode === 'off') return '';
  const now = Date.now();
  if (now - _lastStaticSupervisorInjectAt < STATIC_SUPERVISOR_DEBOUNCE_MS) {
    return '';
  }
  _lastStaticSupervisorInjectAt = now;
  return STATIC_SUPERVISOR_RULES_BODY;
}

/**
 * Extract the main model's text output from an `llm_output` hook context.
 * Handles multiple context shapes across gateway versions: `response`, `assistantTexts`,
 * and `lastAssistant.content` (string or content block array).
 */
function extractLlmOutputText(raw: Record<string, unknown>): string | undefined {
  const direct = raw.response;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;

  const assistantTexts = raw.assistantTexts;
  if (Array.isArray(assistantTexts) && assistantTexts.length > 0) {
    const joined = assistantTexts.filter((t): t is string => typeof t === 'string').join('');
    if (joined.trim().length > 0) return joined;
  }

  const last = raw.lastAssistant;
  if (last && typeof last === 'object') {
    const c = (last as { content?: unknown }).content;
    if (typeof c === 'string' && c.trim().length > 0) return c;
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const block of c) {
        if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: string }).text === 'string') {
          parts.push((block as { text: string }).text);
        }
      }
      const s = parts.join('');
      if (s.trim().length > 0) return s;
    }
  }

  return undefined;
}

function extractLlmInputMessages(ctx: unknown): Array<{ role: string; content: unknown }> | undefined {
  const c = ctx as Record<string, unknown>;
  const asMsgs = (v: unknown): Array<{ role: string; content: unknown }> | undefined => {
    if (!Array.isArray(v) || v.length === 0) return undefined;
    return v as Array<{ role: string; content: unknown }>;
  };
  let m = asMsgs(c.messages);
  if (m) return m;
  m = asMsgs(c.historyMessages);
  if (m) return m;
  const body = c.body as Record<string, unknown> | undefined;
  if (body) {
    m = asMsgs(body.messages);
    if (m) return m;
  }
  const req = c.request as Record<string, unknown> | undefined;
  if (req) {
    m = asMsgs(req.messages);
    if (m) return m;
  }
  return undefined;
}

function extractToolCallName(ctx: unknown): string | undefined {
  const c = ctx as { tool?: string; toolName?: string };
  if (typeof c.tool === 'string' && c.tool.length > 0) return c.tool;
  if (typeof c.toolName === 'string' && c.toolName.length > 0) return c.toolName;
  return undefined;
}

const plugin: PluginDefinition = {
  id: 'dual-model-supervisor',
  name: 'Dual Model Supervisor',
  description: 'Dual-model supervision: course correction, memory guarding, and safety filtering',
  version: '0.1.0',

  register(api: PluginApi) {
    const cfg = parseConfig(api.pluginConfig as Record<string, unknown> | undefined);
    _activeConfig = cfg;

    const globalCfg = api.config;
    const mergedProviders = _extractProviders(api.pluginConfig as Record<string, unknown> | undefined, globalCfg);

    api.logger.info(`Dual Model Supervisor initializing (enabled=${cfg.enabled}, mode=${cfg.reviewMode}, model=${cfg.supervisorModel || '(none)'})`);

    if (!_initialized) {
      _db = new Database(DEFAULT_DB_PATH);
      _db.pragma('journal_mode = WAL');
      _db.pragma('synchronous = FULL');

      _auditLog = new AuditLogService(_db, api.logger);

      _reviewerClient = new ReviewerClient({
        supervisorConfig: cfg,
        providers: mergedProviders,
        logger: api.logger,
      });

      _quickChecker = new QuickChecker(cfg, api.logger);
      _outputReviewer = new OutputReviewer(cfg, api.logger, _reviewerClient, _quickChecker, _auditLog);
      _toolReviewer = new ToolReviewer(cfg, api.logger, _reviewerClient, _quickChecker, _auditLog);
      _memoryGuardian = new MemoryGuardian(cfg, api.logger, _reviewerClient, _auditLog);
      _courseCorrector = new CourseCorrector(cfg, api.logger, _reviewerClient, _auditLog);
      _consistencyChecker = new ConsistencyChecker(cfg, api.logger, _reviewerClient, _auditLog);
      _goalParser = new GoalParser(cfg, api.logger, _reviewerClient, _auditLog);
      _summaryExtractor = new SummaryExtractor(cfg, api.logger, _reviewerClient, _auditLog);
      _preReviewFilter = new PreReviewFilter(cfg.preReviewFilter, api.logger);

      process.once('exit', () => {
        try {
          if (_db?.open) {
            _db.pragma('wal_checkpoint(TRUNCATE)');
            _db.close();
          }
        } catch { /* best-effort */ }
      });

      _initialized = true;
    } else {
      _reviewerClient!.updateProviders(mergedProviders);
      _reviewerClient!.updateSupervisorConfig(_activeConfig ?? cfg);
    }

    const reviewerClient = _reviewerClient!;
    const auditLog = _auditLog!;
    const outputReviewer = _outputReviewer!;
    const toolReviewer = _toolReviewer!;
    const memoryGuardian = _memoryGuardian!;
    const courseCorrector = _courseCorrector!;
    const consistencyChecker = _consistencyChecker!;
    const goalParser = _goalParser!;
    const summaryExtractor = _summaryExtractor!;
    const preReviewFilter = _preReviewFilter!;

    api.registerService({
      id: 'supervisor-db',
      start() {
        if (_db?.open) {
          const result = _db.pragma('integrity_check') as Array<{ integrity_check: string }>;
          if (result[0]?.integrity_check !== 'ok') {
            api.logger.warn('Supervisor database integrity check returned warnings');
          }
        }
      },
      stop() {
        if (_db?.open) {
          _db.pragma('wal_checkpoint(TRUNCATE)');
          _db.close();
          api.logger.info('Supervisor database closed');
        }
      },
    });

    const registerMethod = (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
      api.registerGatewayMethod(method, async (opts: {
        params: Record<string, unknown>;
        respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
      }) => {
        try {
          const result = await handler(opts.params);
          opts.respond(true, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          api.logger.error(`RPC ${method} error: ${message}`);
          opts.respond(false, undefined, { code: 'SERVICE_ERROR', message });
        }
      });
    };

    registerSupervisorRpc(
      registerMethod,
      auditLog,
      () => _activeConfig ?? cfg,
      (newCfg: SupervisorConfig) => {
        _activeConfig = newCfg;
        reviewerClient.updateSupervisorConfig(newCfg);
        outputReviewer.updateConfig(newCfg);
        toolReviewer.updateConfig(newCfg);
        memoryGuardian.updateConfig(newCfg);
        courseCorrector.updateConfig(newCfg);
        consistencyChecker.updateConfig(newCfg);
        goalParser.updateConfig(newCfg);
        summaryExtractor.updateConfig(newCfg);
        preReviewFilter.updateConfig(newCfg.preReviewFilter);
      },
      api.logger,
      () => _registry,
      () => _extractConfiguredProviders(api.pluginConfig as Record<string, unknown> | undefined, globalCfg),
      () => _anchors,
    );

    // ── Register hooks ───────────────────────────────────────────

    api.on('session_start', (ctx: unknown) => {
      const c = ctx as { sessionId?: string };
      if (typeof c.sessionId === 'string' && c.sessionId.length > 0) {
        _hookActiveSessionId = c.sessionId;
      }
    });

    // before_prompt_build — inject supervisor rules + session anchors + drained prepend queue + course corrections
    api.on('before_prompt_build', (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const staticBlock = takeStaticSupervisorRulesBlock(activeCfg.reviewMode);

      const c = ctx as { sessionId?: string };
      const sessionId = c.sessionId ?? _hookActiveSessionId ?? undefined;
      if (!sessionId) {
        return staticBlock.length > 0 ? { prependContext: staticBlock } : {};
      }

      let drained = _anchors.drainBlocks(sessionId);
      const anchorView = _anchors.view(sessionId);

      const turn = resolveTurn(_registry, sessionId, 'llm_input', {}, api.logger);

      if (!turn && drained.length > 0) {
        for (const b of drained) {
          _anchors.enqueueBlock(sessionId, b);
        }
        drained = [];
      }

      const injection = turn
        ? courseCorrector.buildContextInjection(turn, drained)
        : { prependContext: undefined as string | undefined };

      const goalLines: string[] = [];
      if (anchorView.researchGoal && anchorView.goalConfirmed) {
        goalLines.push(`[Research Goal] ${anchorView.researchGoal}`);
        if (anchorView.targetConclusions.length > 0) {
          goalLines.push(`[Target Conclusions] You are expected to reach the following conclusions:`);
          for (const target of anchorView.targetConclusions) {
            goalLines.push(`  - ${target}`);
          }
        }
        if (anchorView.methodology) {
          goalLines.push(`[Initial Methodology] ${anchorView.methodology}`);
        }
        if (anchorView.methodologyDecisions.length > 0) {
          goalLines.push(`[Established Methodology Decisions] ${anchorView.methodologyDecisions.join('; ')}`);
        }
        if (anchorView.userPreferences.length > 0) {
          goalLines.push(`[User Preferences You Must Honor] ${anchorView.userPreferences.join('; ')}`);
        }
        if (anchorView.keyConclusions.length > 0) {
          goalLines.push(`[Key Conclusions Reached] ${anchorView.keyConclusions.join('; ')}`);
        }
      }

      const goalContext = goalLines.length > 0 ? goalLines.join('\n') : '';
      const existingContext = injection.prependContext ?? '';
      const merged = [staticBlock, goalContext, existingContext].filter((s) => s.length > 0).join('\n\n');
      return merged ? { prependContext: merged } : {};
    });

    // message_received — create a fresh TurnState for this message and bind
    // it to the async chain via AsyncLocalStorage. Run pre-review filter,
    // gatekeeper, and goal parser against the per-turn state captured in the
    // closure.
    api.on('message_received', (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const context = ctx as { sessionId?: string; message?: string };
      const sessionId = context.sessionId ?? _hookActiveSessionId ?? undefined;
      if (!sessionId) return {};

      const message = context.message ?? '';
      const turn = _registry.create(sessionId, message);
      // Bind this turn into AsyncLocalStorage. Subsequent synchronous and
      // awaited hook handlers in the same async chain will pick it up.
      turnStore.enterWith(turn);

      api.logger.info(
        `[DIAG] message_received: created turn ${turn.turnId} for session ${sessionId} (messageLen=${message.length})`,
      );

      if (message.length > 0) {
        const localResult = preReviewFilter.shouldReview(message);

        if (localResult.decision === 'skip') {
          turn.trivialTurn = true;
          api.logger.info(`[PreReviewFilter] Layer1 SKIP: ${localResult.reason}`);
          auditLog.record({
            sessionId,
            type: 'output_review',
            action: 'info',
            details: `pre_review_filter_skip: ${localResult.reason}`,
            timestamp: Date.now(),
          });
          return {};
        }

        const truncatedMessage = message.slice(0, activeCfg.preReviewFilter.gatekeeperMaxInputChars);
        reviewerClient.review<GatekeeperResult>(GATEKEEPER_SYSTEM_PROMPT, truncatedMessage)
          .then((gateResult) => {
            if (turn.phase === 'sent') {
              api.logger.warn(`[PreReviewFilter] Gatekeeper callback: turn ${turn.turnId} already finished, skipping.`);
              return;
            }
            if (gateResult && !gateResult.needReview) {
              turn.trivialTurn = true;
              api.logger.info(`[PreReviewFilter] Layer2 SKIP (gatekeeper): ${gateResult.reason}`);
              auditLog.record({
                sessionId,
                type: 'output_review',
                action: 'info',
                details: `gatekeeper_skip: ${gateResult.reason}`,
                timestamp: Date.now(),
              });
            } else {
              api.logger.info(`[PreReviewFilter] Layer2 PASS (gatekeeper): ${gateResult?.reason ?? 'no result'}`);
              goalParser.parseGoal(message, turn, _anchors);
            }
          })
          .catch((err) => {
            api.logger.error(`[PreReviewFilter] Gatekeeper failed: ${err instanceof Error ? err.message : String(err)}`);
            if (turn.phase !== 'sent') {
              goalParser.parseGoal(message, turn, _anchors);
            }
          });
        return {};
      }

      return {};
    });

    // llm_input — consistency check + enqueue correction via PendingBlock
    api.on('llm_input', async (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const messages = extractLlmInputMessages(ctx);
      if (!messages || messages.length === 0) {
        return;
      }

      const context = ctx as { sessionId?: string };
      const sessionId = context.sessionId ?? _hookActiveSessionId ?? undefined;

      const turn = resolveTurn(
        _registry,
        sessionId,
        'llm_input',
        { userMessage: extractLastUserMessageText(messages) },
        api.logger,
      );
      if (!turn) {
        api.logger.warn(`[DIAG] llm_input: no active turn for session ${sessionId ?? '(none)'}`);
        return;
      }
      _registry.advancePhase(turn, 'llm_input');

      if (turn.trivialTurn) {
        api.logger.info(`[DIAG] llm_input: Trivial turn ${turn.turnId} — skipping consistency check`);
        return;
      }

      const sid = sessionId ?? turn.sessionId;
      const result = await consistencyChecker.checkConsistency(messages, turn, _anchors.view(sid), _anchors);
      if (result.correctionText) {
        _anchors.enqueueBlock(sid, { type: 'consistencyCorrection', text: result.correctionText });
      }
    });

    // llm_output — record raw output, extract structured summary, run course
    // correction and output review. All async work captures the exact turn in
    // its closure with a stale-turn guard.
    api.on('llm_output', (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const context = ctx as Record<string, unknown>;
      const outputText = extractLlmOutputText(context);
      const sessionId = (context.sessionId as string | undefined) ?? _hookActiveSessionId ?? undefined;

      if (sessionId && sessionId !== _hookActiveSessionId) {
        _hookActiveSessionId = sessionId;
      }

      api.logger.info(`[DIAG] llm_output ENTERED. sessionId=${sessionId}, hasOutputText=${!!outputText}, outputLen=${outputText?.length ?? 0}, ctxKeys=${Object.keys(context).join(',')}`);

      if (!sessionId || !outputText) {
        api.logger.info(`[DIAG] llm_output EARLY EXIT. sessionId=${sessionId}, hasOutputText=${!!outputText}`);
        return;
      }

      const turn = resolveTurn(_registry, sessionId, 'llm_output', {}, api.logger);
      if (!turn) {
        api.logger.warn(`[DIAG] llm_output: no active turn for session ${sessionId}`);
        return;
      }
      _registry.advancePhase(turn, 'llm_output');

      try {
        turn.turnLlmOutput = outputText;

        if (turn.trivialTurn) {
          api.logger.info(`[DIAG] llm_output: Trivial turn ${turn.turnId} — skipping summary/review/course-correction`);
          return;
        }

        summaryExtractor.extractSummary(outputText, turn);
        if (isCourseCorrectionActive(activeCfg)) {
          courseCorrector.analyzeSession(turn, _anchors.view(sessionId), _anchors);
        }

        if (!outputText.includes(SUPERVISOR_REVIEW_SUMMARY_MARKER)) {
          const shouldAttachToChannel = activeCfg.appendReviewToChannelOutput;
          api.logger.info(`[DIAG] llm_output: Starting ASYNC review for turn ${turn.turnId}. shouldAttachToChannel=${shouldAttachToChannel}`);
          const reviewStartTime = Date.now();
          outputReviewer.reviewMessageSending(outputText, turn, _anchors.view(sessionId), _anchors, {
            attachSummary: shouldAttachToChannel,
          }).then((modified) => {
            const elapsed = Date.now() - reviewStartTime;
            if (turn.phase === 'sent') {
              api.logger.warn(`[DIAG] llm_output: ASYNC review completed after turn ${turn.turnId} was finalized — discarding.`);
              return;
            }
            if (modified !== null) {
              turn.pendingChannelReviewFooter = modified;
              api.logger.info(`[DIAG] llm_output: ASYNC review COMPLETED in ${elapsed}ms. Channel footer cached (${modified.length} chars)`);
            } else {
              api.logger.info(`[DIAG] llm_output: ASYNC review returned null in ${elapsed}ms.`);
            }
          }).catch((err) => {
            api.logger.error(`[DIAG] llm_output: ASYNC review FAILED: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        api.logger.error(
          `[DIAG] llm_output SYNC error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      api.logger.info(`[DIAG] llm_output EXITING (sync portion done)`);
    });

    // message_sending — for channel delivery, attach review footer (cached or
    // live) then finalize the turn.
    api.on('message_sending', async (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      const context = ctx as { sessionId?: string; message?: string };
      api.logger.info(`[DIAG] message_sending ENTERED. enabled=${activeCfg.enabled}, reviewMode=${activeCfg.reviewMode}, hasMessage=${!!context.message}, messageLen=${context.message?.length ?? 0}, sessionId=${context.sessionId ?? '(none)'}`);

      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      if (!context.message) {
        return {};
      }

      const snap = snapshotMessageSendingCtx(ctx);
      const isChannelDelivery = snap.isChannelDelivery;
      api.logger.info(`[DIAG] message_sending: isChannelDelivery=${isChannelDelivery}, channel=${JSON.stringify(snap.flags.channel)}, source=${JSON.stringify(snap.flags.source)}`);

      if (snap.deferReview) {
        api.logger.info(`[DIAG] message_sending: deferReview=true, returning {}`);
        return {};
      }

      const sessionId = context.sessionId ?? _hookActiveSessionId ?? undefined;
      const turn = resolveTurn(_registry, sessionId, 'sending', {}, api.logger);
      if (!turn) {
        api.logger.warn(`[DIAG] message_sending: no active turn for session ${sessionId ?? '(none)'}; passing through`);
        return {};
      }
      _registry.advancePhase(turn, 'sending');

      try {
        if (!isChannelDelivery) {
          api.logger.info(`[DIAG] message_sending: Not a channel delivery — skipping footer append.`);
          if (turn.pendingChannelReviewFooter) {
            api.logger.info(`[DIAG] message_sending: Clearing cached channel footer (${turn.pendingChannelReviewFooter.length} chars)`);
            turn.pendingChannelReviewFooter = undefined;
          }
          return {};
        }

        if (turn.pendingChannelReviewFooter) {
          const footer = turn.pendingChannelReviewFooter;
          turn.pendingChannelReviewFooter = undefined;
          api.logger.info(`[DIAG] message_sending: Found CACHED channel footer (${footer.length} chars), returning it`);
          return { message: footer };
        }

        if (!activeCfg.appendReviewToChannelOutput) {
          api.logger.info(`[DIAG] message_sending: appendReviewToChannelOutput=false, skipping footer`);
          return {};
        }

        api.logger.info(`[DIAG] message_sending: No cached footer, performing LIVE review for turn ${turn.turnId}`);
        const reviewStartTime = Date.now();
        const modified = await outputReviewer.reviewMessageSending(
          context.message,
          turn,
          sessionId ? _anchors.view(sessionId) : undefined,
          sessionId ? _anchors : undefined,
          { attachSummary: true },
        );
        const elapsed = Date.now() - reviewStartTime;

        if (modified !== null) {
          api.logger.info(`[DIAG] message_sending: LIVE review completed in ${elapsed}ms, returning modified (${modified.length} chars)`);
          return { message: modified };
        }

        api.logger.info(`[DIAG] message_sending: LIVE review returned null in ${elapsed}ms.`);
        return {};
      } finally {
        if (sessionId) {
          _anchors.merge(sessionId, turn.stagedAnchorUpdates);
        }
        turn.stagedAnchorUpdates = {};
        _registry.finish(turn);
        api.logger.info(`[DIAG] message_sending: finalized turn ${turn.turnId}`);
      }
    });

    // before_message_write — sync hook; we don't modify the message here.
    // Review is driven asynchronously from `llm_output`.
    api.on('before_message_write', () => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }
      return {};
    });

    // before_tool_call — tool call review (sessionId-scoped, no turn needed)
    api.on('before_tool_call', async (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const context = ctx as { sessionId?: string; params?: Record<string, unknown> };
      const tool = extractToolCallName(ctx);
      if (!tool) {
        return {};
      }

      const sessionId = context.sessionId ?? _hookActiveSessionId ?? 'default';
      const result = await toolReviewer.review(tool, context.params ?? {}, sessionId);

      if (result.block) {
        return { block: true, blockReason: result.blockReason };
      }
      if (result.params) {
        return { params: result.params };
      }

      return {};
    });

    // before_compaction — capture key memory into compaction event (no turn required)
    api.on('before_compaction', async (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const context = ctx as { sessionId?: string; messages?: Array<{ role: string; content: unknown }> };
      if (!context.messages) {
        return {};
      }

      const sessionId = context.sessionId ?? _hookActiveSessionId ?? undefined;
      if (!sessionId) {
        return {};
      }

      const ev = _compactions.begin(sessionId);
      await memoryGuardian.beforeCompaction(context.messages, ev);
    });

    // after_compaction — memory loss detection + anchors merge
    api.on('after_compaction', async (ctx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const context = ctx as {
        sessionId?: string;
        original?: Array<{ role: string; content: unknown }>;
        compacted?: Array<{ role: string; content: unknown }>;
      };

      if (!context.original || !context.compacted) {
        return;
      }

      const sessionId = context.sessionId ?? _hookActiveSessionId ?? undefined;
      if (!sessionId) {
        return;
      }

      const ev = _compactions.current(sessionId);
      if (!ev) {
        api.logger.warn(`[DIAG] after_compaction: no compaction event for session ${sessionId}`);
        return;
      }

      await memoryGuardian.afterCompaction(
        context.original,
        context.compacted,
        ev,
        _anchors.view(sessionId),
        _anchors,
      );
      _compactions.end(sessionId);
    });

    // session_end — emit regeneration summaries for any still-active turns,
    // then drop the entire session from the registry.
    api.on('session_end', (ctx: unknown) => {
      const context = ctx as { sessionId?: string };
      if (!context.sessionId) return;

      const activeTurns = _registry.listActive(context.sessionId);
      for (const turn of activeTurns) {
        if (turn.regenerateHistory.length > 0) {
          const summary = courseCorrector.buildRegenerationSummary(turn);
          if (summary) {
            auditLog.record({
              sessionId: context.sessionId,
              type: 'force_regenerate',
              action: 'info',
              details: summary,
              timestamp: Date.now(),
            });
            api.logger.info(`[Supervisor] Turn ${turn.turnId} regeneration summary: ${turn.regenerateHistory.length} attempt(s)`);
          }
        }
        _registry.finish(turn);
      }
      _registry.dropSession(context.sessionId);
      _anchors.drop(context.sessionId);
      _compactions.dropAll(context.sessionId);
      if (context.sessionId === _hookActiveSessionId) {
        _hookActiveSessionId = null;
      }
    });

    api.logger.info('Dual Model Supervisor registered (7 hooks + 6 RPC methods)');
  },
};

// Expose a shape so RPC can surface both per-session and per-turn info.
export type { TurnState };

/**
 * Merge provider maps: root `config.models.providers` (OpenClaw global) + plugin entry overrides.
 * Plugin-specific `providers` / `models.providers` win on key collision.
 */
function _extractProviders(
  pluginConfig?: Record<string, unknown>,
  globalConfig?: Record<string, unknown>,
): Record<string, ModelsProviderEntry> {
  const globalModels = globalConfig?.models as Record<string, unknown> | undefined;
  const fromGlobal = (globalModels?.providers as Record<string, ModelsProviderEntry> | undefined) ?? {};

  if (!pluginConfig) {
    return { ...fromGlobal };
  }

  const pluginProviders = pluginConfig.providers as Record<string, ModelsProviderEntry> | undefined;
  if (pluginProviders && Object.keys(pluginProviders).length > 0) {
    return { ...fromGlobal, ...pluginProviders };
  }

  const models = pluginConfig.models as Record<string, unknown> | undefined;
  const modelsProviders = models?.providers as Record<string, ModelsProviderEntry> | undefined;
  if (modelsProviders && Object.keys(modelsProviders).length > 0) {
    return { ...fromGlobal, ...modelsProviders };
  }

  return { ...fromGlobal };
}

function _extractConfiguredProviders(
  pluginConfig?: Record<string, unknown>,
  globalConfig?: Record<string, unknown>,
): ConfiguredProvider[] {
  const providers = _extractProviders(pluginConfig, globalConfig);
  const result: ConfiguredProvider[] = [];

  for (const [key, cfg] of Object.entries(providers)) {
    if (!cfg.baseUrl) continue;
    result.push({
      key,
      label: key,
      hasApiKey: Boolean(cfg.apiKey),
      models: (cfg.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
      baseUrl: cfg.baseUrl,
      api: cfg.api,
    });
  }

  return result;
}

export default plugin;
