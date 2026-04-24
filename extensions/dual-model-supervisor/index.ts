/**
 * Dual Model Supervisor — Plugin Entry Point
 *
 * Registers 7 hooks + 6 RPC methods for dual-model supervision:
 *   - Turn creation & pre-review (before_prompt_build: Layer1 filter + Layer2 gatekeeper)
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

import * as fs from 'node:fs';
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
  ReviewResult,
} from './src/core/types.js';
import { parseConfig, isSupervisorActive, isCourseCorrectionActive, isForceRegenerateActive } from './src/core/config.js';
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
import { validateGatekeeperResult } from './src/core/validators.js';
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
import { extractMessages, extractModelOutput, sanitizeUserMessage } from './src/utils/hook-context.js';

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

/** Guard to prevent duplicate hook/service registration on the same OC api instance.
 *  OpenClaw may call register() multiple times with different registry passes;
 *  a module-level boolean blocks subsequent passes, leaving hooks on a stale registry.
 *  WeakSet tracks per-api identity so each distinct api gets its hooks, but the same
 *  api is never registered twice. */
const _registeredApis = new WeakSet<PluginApi>();

const _registry = new TurnRegistry();
const _anchors = new SessionAnchorsRegistry();
const _compactions = new CompactionEventRegistry();

const DEFAULT_DB_PATH = path.join(os.homedir(), '.research-claw', 'supervisor.db');

const STATIC_SUPERVISOR_RULES_BODY = [
  '[Supervisor] You are under dual-model supervision. Follow these rules:',
  '  - Do NOT fabricate citations, data, or experimental results',
  '  - Do NOT deviate from the current research topic',
  '  - If you have forgotten key information discussed earlier, explicitly state: "I may have lost context, please remind me"',
].join('\n');

/**
 * Gate static supervisor rules: OpenClaw may call `before_prompt_build` several times per user turn;
 * each return value is concatenated, which previously duplicated this block 2–3×.
 * Uses TurnState.staticRulesInjected for precise per-turn deduplication.
 */
function takeStaticSupervisorRulesBlock(reviewMode: string, turn?: TurnState): string {
  if (reviewMode === 'off') return '';
  // No turn context: inject once (no duplication risk without turn stitching)
  if (!turn) return STATIC_SUPERVISOR_RULES_BODY;
  if (turn.staticRulesInjected) return '';
  turn.staticRulesInjected = true;
  return STATIC_SUPERVISOR_RULES_BODY;
}

const plugin: PluginDefinition = {
  id: 'dual-model-supervisor',
  name: 'Dual Model Supervisor',
  description: 'Dual-model supervision: course correction, memory guarding, and safety filtering',
  version: '0.1.1',

  register(api: PluginApi) {
    const cfg = parseConfig(api.pluginConfig as Record<string, unknown> | undefined);
    _activeConfig = cfg;

    const globalCfg = api.config;
    const mergedProviders = _extractProviders(api.pluginConfig as Record<string, unknown> | undefined, globalCfg);

    // Extract main model reference for fallback when supervisorModel is empty
    const mainModel = (globalCfg?.agents as Record<string, unknown>)?.defaults as Record<string, unknown>;
    const mainModelPrimary = (mainModel?.model as Record<string, unknown>)?.primary;
    const fallbackModel = typeof mainModelPrimary === 'string' ? mainModelPrimary : '';

    if (!_initialized) {
      _db = new Database(DEFAULT_DB_PATH);
      _db.pragma('journal_mode = WAL');
      _db.pragma('synchronous = FULL');

      _auditLog = new AuditLogService(_db, api.logger);

      _reviewerClient = new ReviewerClient({
        supervisorConfig: cfg,
        providers: mergedProviders,
        logger: api.logger,
        fallbackModel,
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
      _reviewerClient!.updateFallbackModel(fallbackModel);
    }

    const reviewerClient = _reviewerClient!;
    const auditLog = _auditLog!;
    const outputReviewer = _outputReviewer!;
    const toolReviewer = _toolReviewer!;
    const quickChecker = _quickChecker!;
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

    // ── Config persistence callback ────────────────────────────────
    const configPath = path.join(process.cwd(), 'config', 'openclaw.json');
    const persistConfig = (newCfg: SupervisorConfig): void => {
      try {
        if (!fs.existsSync(configPath)) return;
        const raw = fs.readFileSync(configPath, 'utf8');
        const ocConfig = JSON.parse(raw);
        if (!ocConfig.plugins) ocConfig.plugins = {};
        if (!ocConfig.plugins.entries) ocConfig.plugins.entries = {};
        if (!ocConfig.plugins.entries['dual-model-supervisor']) {
          ocConfig.plugins.entries['dual-model-supervisor'] = {};
        }
        ocConfig.plugins.entries['dual-model-supervisor'].config = {
          enabled: newCfg.enabled,
          supervisorModel: newCfg.supervisorModel,
          reviewMode: newCfg.reviewMode,
          appendReviewToChannelOutput: newCfg.appendReviewToChannelOutput,
          memoryGuard: newCfg.memoryGuard,
          courseCorrection: newCfg.courseCorrection,
          preReviewFilter: newCfg.preReviewFilter,
          highRiskTools: newCfg.highRiskTools,
        };
        const tmpPath = configPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(ocConfig, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, configPath);
      } catch (err) {
        api.logger.error(`Failed to persist supervisor config: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      persistConfig,
    );

    // ── Register hooks (guarded per-api to survive OC multi-pass register) ──
    if (_registeredApis.has(api)) {
      return;
    }

    api.on('session_start', (event: unknown, hookCtx: unknown) => {
      const ev = event as { sessionId?: string; sessionKey?: string };
      const ct = hookCtx as { sessionId?: string; sessionKey?: string };
      const sessionId = ev.sessionId ?? ct.sessionId;
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        _hookActiveSessionId = sessionId;
      }
    });

    // before_prompt_build — primary turn creation + pre-review (Layer1 + Layer2 gatekeeper),
    // then inject supervisor rules + session anchors + drained prepend queue + course corrections.
    // Tool loops call this multiple times; resolveTurn(..., 'received', { userMessage: prompt }) dedupes creation.
    api.on('before_prompt_build', async (event: unknown, hookCtx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const ev = event as { prompt?: string; messages?: unknown[] };
      const ct = hookCtx as { sessionId?: string; agentId?: string; sessionKey?: string };
      const sessionId = ct.sessionId ?? _hookActiveSessionId ?? undefined;
      if (sessionId && !_hookActiveSessionId) {
        _hookActiveSessionId = sessionId;
      }

      const rawUserMessage = sanitizeUserMessage(ev.prompt ?? '');

      let turn: TurnState | undefined;
      if (sessionId) {
        turn = resolveTurn(
          _registry,
          sessionId,
          'received',
          { userMessage: rawUserMessage },
          api.logger,
        );
      }

      if (!turn && sessionId) {
        turn = _registry.create(sessionId, rawUserMessage);
        turnStore.enterWith(turn);

        if (rawUserMessage.length > 0) {
          const localResult = preReviewFilter.shouldReview(rawUserMessage);
          if (localResult.decision === 'skip') {
            turn.trivialTurn = true;
            auditLog.record({
              sessionId,
              type: 'output_review',
              action: 'info',
              details: `pre_review_filter_skip: ${localResult.reason}`,
              timestamp: Date.now(),
            });
          } else {
            try {
              const truncatedMessage = rawUserMessage.slice(0, activeCfg.preReviewFilter.gatekeeperMaxInputChars);
              const wrappedMessage = `<user_content>\n${truncatedMessage}\n</user_content>`;
              const rawResult = await reviewerClient.review<GatekeeperResult>(GATEKEEPER_SYSTEM_PROMPT, wrappedMessage);
              const gateResult = validateGatekeeperResult(rawResult);
              if (gateResult && !gateResult.needReview) {
                turn.trivialTurn = true;
                auditLog.record({
                  sessionId,
                  type: 'output_review',
                  action: 'info',
                  details: `gatekeeper_skip: ${gateResult.reason}`,
                  timestamp: Date.now(),
                });
              } else {
                goalParser.parseGoal(rawUserMessage, turn, _anchors);
              }
            } catch (err) {
              api.logger.error(`[PreReviewFilter] Gatekeeper failed: ${err instanceof Error ? err.message : String(err)}`);
              goalParser.parseGoal(rawUserMessage, turn, _anchors);
            }
          }
        }
      }

      const staticBlock = takeStaticSupervisorRulesBlock(activeCfg.reviewMode, turn);
      if (!sessionId) {
        return staticBlock.length > 0 ? { prependContext: staticBlock } : {};
      }

      let drained = _anchors.drainBlocks(sessionId);
      const anchorView = _anchors.view(sessionId);

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

    // message_received — lightweight diagnostic hook only.
    api.on('message_received', (_: unknown, _hookCtx: unknown) => {
      return {};
    });

    // llm_input — consistency check + enqueue correction via PendingBlock
    api.on('llm_input', async (event: unknown, hookCtx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const ev = event as Record<string, unknown>;
      const ct = hookCtx as { sessionId?: string; agentId?: string };
      const messages = extractMessages(ev);
      if (!messages || messages.length === 0) {
        return;
      }

      const sessionId = (ev.sessionId as string | undefined) ?? ct.sessionId ?? _hookActiveSessionId ?? undefined;

      // Update _hookActiveSessionId if we just got one
      if (sessionId && !_hookActiveSessionId) {
        _hookActiveSessionId = sessionId;
      }

      let turn = resolveTurn(
        _registry,
        sessionId,
        'llm_input',
        { userMessage: extractLastUserMessageText(messages) },
        api.logger,
      );

      // Fallback: if before_prompt_build missed creating a turn, create one here as a last resort
      if (!turn && sessionId) {
        const userMessage = extractLastUserMessageText(messages) ?? '';
        turn = _registry.create(sessionId, userMessage);
        turnStore.enterWith(turn);
      }

      if (!turn) {
        return;
      }
      _registry.advancePhase(turn, 'llm_input');

      if (turn.trivialTurn) {
        return;
      }

      const sid = sessionId ?? turn.sessionId;
      const result = await consistencyChecker.checkConsistency(messages, turn, _anchors.view(sid), _anchors);
      if (result.correctionText) {
        _anchors.enqueueBlock(sid, { type: 'consistencyCorrection', text: result.correctionText });
      }
    });

    // llm_output — record raw output, launch review Promise (stored on turn),
    // and advance phase. The Promise runs: extractSummary → analyzeSession →
    // deepReview, then resolves to ReviewResult | null.
    // message_sending will await turn.reviewPromise before making its decision.
    api.on('llm_output', (event: unknown, hookCtx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const ev = event as Record<string, unknown>;
      const ct = hookCtx as { sessionId?: string };
      const outputText = extractModelOutput(ev);
      const sessionId = (ev.sessionId as string | undefined) ?? ct.sessionId ?? _hookActiveSessionId ?? undefined;

      // Update _hookActiveSessionId if we just got one
      if (sessionId && !_hookActiveSessionId) {
        _hookActiveSessionId = sessionId;
      }

      if (!sessionId || !outputText) {
        return;
      }

      const turn = resolveTurn(_registry, sessionId, 'llm_output', {}, api.logger);
      if (!turn) {
        return;
      }
      _registry.advancePhase(turn, 'llm_output');

      try {
        turn.turnLlmOutput = outputText;

        if (turn.trivialTurn) {
          return;
        }

        if (outputText.includes(SUPERVISOR_REVIEW_SUMMARY_MARKER)) {
          return;
        }

        // Launch the review pipeline.
        //
        // Architecture (Step 1 → Step 2 → Step 3, all serial in llm_output):
        //
        //   llm_output fires (turn.phase = llm_output)
        //       │
        //       ├── Step 1 (extractSummary)
        //       ├── Step 2 (analyzeSession) ── may set turn.shouldRegenerate=true
        //       ├── [shouldRegenerate? skip Step 3 : run Step 3]
        //       ├── Step 3 (deepReview) ── may set turn.shouldRegenerate=true (if blocked)
        //       └── resolve(ReviewResult | null)
        //
        //   message_sending fires (turn.phase = sending)
        //       │
        //       ├── await reviewPromise → read turn.shouldRegenerate + resolved result
        //       └── decision: intercept / pass / append footer
        //
        // Key properties:
        // - Step 2 can consume Step 1's result (stagedAnchorUpdates) immediately after Step 1 completes.
        // - Step 3 is skipped when shouldRegenerate=true (set by Step 2), saving an API call.
        // - Step 3 blocked also sets shouldRegenerate=true, unifying the interception signal.
        // - message_sending is a pure consumer: no API calls, only reads turn state.
        //
        const anchorsView = _anchors.view(sessionId);
        const reviewTimeout = 60_000; // 60s timeout, configurable in future

        // ── Phase A: Steps 1 → 2 → [3] serial ─────────────────────────────────
        // Step 2 (analyzeSession) depends on Step 1's staged result (recentSummaries in stagedAnchorUpdates).
        // Step 3 (deepReview) is skipped if shouldRegenerate=true after Step 2.
        turn.reviewPromise = (async (): Promise<ReviewResult | null> => {
          try {
            // Step 1: extract summary and stage it for Step 2 to consume.
            const t1 = Date.now();
            await summaryExtractor.extractSummary(outputText, turn);

            // Step 2: analyze session context — now reads Step 1's staged summary.
            if (isCourseCorrectionActive(activeCfg)) {
              await courseCorrector.analyzeSession(turn, anchorsView, _anchors);
            }
          } catch (err) {
            // Non-fatal: log and continue so Step 3 can still run.
            api.logger.error(`Review pipeline (Steps 1→2) failed for turn ${turn.turnId}: ${err instanceof Error ? err.message : String(err)}`);
          }

          // Step 3: deepReview — skipped if shouldRegenerate is already true (set by Step 2).
          // This avoids wasting an API call on an output that will be intercepted anyway.
          if (turn.shouldRegenerate) {
            return null;
          }

          try {
            const reviewResult = await outputReviewer.deepReview(outputText, turn, anchorsView);

            // If blocked, set shouldRegenerate so message_sending intercepts uniformly.
            if (reviewResult?.blocked) {
              turn.shouldRegenerate = true;
            }

            // Write review report to anchors for the NEXT turn's context.
            // Guard against the turn having already been sent by the time Step 3 returns.
            if (reviewResult && turn.phase !== 'sent') {
              const reportBody = reviewResult.reportText?.trim()
                ? reviewResult.reportText.trim()
                : ((): string => {
                    const lines: string[] = [];
                    if (reviewResult.blocked) lines.push('⛔ Deep review flagged this output (blocked)');
                    for (const w of reviewResult.warnings) lines.push(`⚠ ${w}`);
                    for (const m of reviewResult.memoryAlerts) lines.push(`🧠 ${m}`);
                    if (reviewResult.correctionNote) lines.push(`📝 ${reviewResult.correctionNote}`);
                    const devStr = reviewResult.deviationScore != null && typeof reviewResult.deviationScore === 'number'
                      ? reviewResult.deviationScore.toFixed(2) : 'n/a';
                    lines.push(`(quality ${reviewResult.qualityScore.toFixed(2)}, deviation ${devStr})`);
                    return lines.join('\n');
                  })();

              turn.lastReviewReport = reportBody;
              if (reportBody.length > 0) {
                _anchors.pushReviewReport(turn.sessionId, reportBody);
                _anchors.enqueueBlock(turn.sessionId, {
                  type: 'previousReview',
                  text: `[Supervisor Last Review] In your previous response, the reviewer noted:\n${reportBody}\nPlease address these points if relevant.`,
                });
              }
            }

            return reviewResult;
          } catch (err) {
            api.logger.error(`Review pipeline Step 3 failed for turn ${turn.turnId}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        })();

        // Apply 60s timeout to the Steps 1→2→3 serial promise.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<ReviewResult | null>((resolve) => {
          timeoutHandle = setTimeout(() => {
            api.logger.warn(`[ReviewPipeline] Steps 1→2→3 timed out for turn ${turn.turnId} after ${reviewTimeout}ms`);
            resolve(null);
          }, reviewTimeout);
        });
        turn.reviewPromise = Promise.race([
          turn.reviewPromise,
          timeoutPromise,
        ]).finally(() => {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
        });
      } catch (err) {
        api.logger.error(`[Supervisor] llm_output SYNC error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // message_sending — await review result, then decide: pass / block / force-regenerate.
    // For channel delivery, optionally append review footer.
    api.on('message_sending', async (event: unknown, hookCtx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      const ev = event as { to?: string; content?: string; metadata?: Record<string, unknown> };
      const ct = hookCtx as { channelId?: string; accountId?: string; conversationId?: string };
      const message = ev.content ?? '';
      const mergedCtx = { ...ev, ...ct, ...(ev.metadata ?? {}) };

      if (!isSupervisorActive(activeCfg) || !message) {
        return {};
      }

      const snap = snapshotMessageSendingCtx(mergedCtx);
      const isChannelDelivery = snap.isChannelDelivery;

      if (snap.deferReview) {
        return {};
      }

      const sessionId = _hookActiveSessionId ?? undefined;
      const turn = resolveTurn(_registry, sessionId, 'sending', {}, api.logger);
      if (!turn) {
        return {};
      }
      _registry.advancePhase(turn, 'sending');

      try {
        // All review steps run in llm_output; this hook only reads the results.
        const reviewResult = turn.reviewPromise ? await turn.reviewPromise : null;
        turn.reviewPromise = undefined;

        // ── Priority 1: Regeneration interception ──────────────────────────
        // Unified signal: whether triggered by deviation (Step 2) or blocked content (Step 3),
        // shouldRegenerate=true means "this output is unusable, must regenerate".
        if (turn.shouldRegenerate && isForceRegenerateActive(activeCfg)) {
          if (turn.regenerateHistory.length < activeCfg.courseCorrection.maxRegenerateAttempts) {
            const maxAttempts = activeCfg.courseCorrection.maxRegenerateAttempts;
            const attempt = turn.regenerateHistory.length + 1;
            auditLog.record({
              sessionId: turn.sessionId,
              type: 'force_regenerate',
              action: 'block',
              details: `Output blocked for regeneration attempt ${attempt}/${maxAttempts}`,
              timestamp: Date.now(),
            });
            const blockMessage = `🔄 [Supervisor] Output blocked — deviation detected. Regenerating corrected content (attempt ${attempt}/${maxAttempts})...`;
            return { content: blockMessage };
          }
          // Max attempts reached — let imperfect output pass
        }

        // ── Priority 2: Quick check (synchronous, always runs) ─────────────
        const quickResult = quickChecker.check(message);
        if (quickResult.blocked) {
          auditLog.record({
            sessionId: turn.sessionId,
            type: 'output_review',
            action: 'block',
            details: quickResult.blockReason ?? 'Blocked by quick checker',
            timestamp: Date.now(),
          });
          const blockMessage = `⚠️ [Supervisor] Output blocked by review. Reason: ${quickResult.blockReason}`;
          return { content: blockMessage };
        }

        // ── Priority 3: Append review footer for channel delivery ──────────
        if (isChannelDelivery && activeCfg.appendReviewToChannelOutput && !message.includes(SUPERVISOR_REVIEW_SUMMARY_MARKER)) {
          const sections: string[] = [];

          // Quick check warnings
          if (quickResult.warnings.length > 0) {
            sections.push(...quickResult.warnings.map((w: string) => `  ⚠ [Quick] ${w}`));
          }

          // Deep review report (from Step 3, already computed in llm_output)
          if (reviewResult) {
            const reportBody = reviewResult.reportText?.trim()
              ? reviewResult.reportText.trim()
              : ((): string => {
                  const lines: string[] = [];
                  for (const w of reviewResult.warnings) lines.push(`  ⚠ ${w}`);
                  for (const m of reviewResult.memoryAlerts) lines.push(`  🧠 ${m}`);
                  if (reviewResult.correctionNote) lines.push(`  📝 ${reviewResult.correctionNote}`);
                  const devStr = reviewResult.deviationScore != null && typeof reviewResult.deviationScore === 'number'
                    ? reviewResult.deviationScore.toFixed(2) : 'n/a';
                  lines.push(`  (quality ${reviewResult.qualityScore.toFixed(2)}, deviation ${devStr})`);
                  return lines.join('\n');
                })();
            sections.push(reportBody);
          } else {
            sections.push('  ℹ [Supervisor] Deep review did not return a result (reviewer unavailable, timeout, or parse error). Quick check passed.');
          }

          if (sections.length > 0) {
            const finalMessage = `${message}\n\n---\n${SUPERVISOR_REVIEW_SUMMARY_MARKER}\n${sections.join('\n')}`;
            return { content: finalMessage };
          }
        }

        // Pass-through: review passed or not a channel delivery
        return {};
      } finally {
        if (sessionId) {
          _anchors.merge(sessionId, turn.stagedAnchorUpdates);
        }
        turn.stagedAnchorUpdates = {};
        _registry.finish(turn);
        api.logger.info(`[Supervisor] message_sending: finalized turn ${turn.turnId}`);
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
    api.on('before_tool_call', async (event: unknown, hookCtx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const ev = event as { toolName?: string; params?: Record<string, unknown>; tool?: string };
      const ct = hookCtx as { sessionId?: string };
      const tool = ev.toolName ?? ev.tool;
      if (!tool) {
        return {};
      }

      const sessionId = ct.sessionId ?? _hookActiveSessionId ?? 'default';
      const result = await toolReviewer.review(tool, ev.params ?? {}, sessionId);

      if (result.block) {
        return { block: true, blockReason: result.blockReason };
      }
      if (result.params) {
        return { params: result.params };
      }

      return {};
    });

    // before_compaction — capture key memory into compaction event (no turn required)
    api.on('before_compaction', async (event: unknown, hookCtx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return {};
      }

      const ev = event as { messages?: Array<{ role: string; content: unknown }> };
      const ct = hookCtx as { sessionId?: string };
      if (!ev.messages) {
        return {};
      }

      const sessionId = ct.sessionId ?? _hookActiveSessionId ?? undefined;
      if (!sessionId) {
        return {};
      }

      const compEv = _compactions.begin(sessionId);
      await memoryGuardian.beforeCompaction(ev.messages, compEv);
    });

    // after_compaction — memory loss detection + anchors merge
    api.on('after_compaction', async (event: unknown, hookCtx: unknown) => {
      const activeCfg = _activeConfig ?? cfg;
      if (!isSupervisorActive(activeCfg)) {
        return;
      }

      const ev = event as {
        original?: Array<{ role: string; content: unknown }>;
        compacted?: Array<{ role: string; content: unknown }>;
      };
      const ct = hookCtx as { sessionId?: string };

      if (!ev.original || !ev.compacted) {
        return;
      }

      const sessionId = ct.sessionId ?? _hookActiveSessionId ?? undefined;
      if (!sessionId) {
        return;
      }

      const compEv = _compactions.current(sessionId);
      if (!compEv) {
        return;
      }

      await memoryGuardian.afterCompaction(
        ev.original,
        ev.compacted,
        compEv,
        _anchors.view(sessionId),
        _anchors,
      );
      _compactions.end(sessionId);
    });

    // session_end — emit regeneration summaries for any still-active turns,
    // then drop the entire session from the registry.
    api.on('session_end', (event: unknown, hookCtx: unknown) => {
      const ev = event as { sessionId?: string };
      const ct = hookCtx as { sessionId?: string };
      const sessionId = ev.sessionId ?? ct.sessionId;
      if (!sessionId) return;

      const activeTurns = _registry.listActive(sessionId);
      for (const turn of activeTurns) {
        if (turn.regenerateHistory.length > 0) {
          const summary = courseCorrector.buildRegenerationSummary(turn);
          if (summary) {
            auditLog.record({
              sessionId,
              type: 'force_regenerate',
              action: 'info',
              details: summary,
              timestamp: Date.now(),
            });
          }
        }
        _registry.finish(turn);
      }
      _registry.dropSession(sessionId);
      _anchors.drop(sessionId);
      _compactions.dropAll(sessionId);
      if (sessionId === _hookActiveSessionId) {
        _hookActiveSessionId = null;
      }
    });

    _registeredApis.add(api);
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
