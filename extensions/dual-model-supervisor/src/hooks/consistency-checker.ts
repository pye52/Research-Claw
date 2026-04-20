/**
 * Dual Model Supervisor — ConsistencyChecker (`llm_input` hook)
 *
 * Responsibilities (two parallel sub-checks)
 *  1. **Recent conversation consistency** (`CONSISTENCY_CHECK_SYSTEM_PROMPT`): before the main LLM
 *     actually receives the messages, compare the last ~10 messages against anchors (researchGoal /
 *     methodologyDecisions / userPreferences / keyConclusions). If internal contradictions or conflicts
 *     with established agreements are found, **return correctionText** which the `llm_input` handler
 *     enqueues as a `consistencyCorrection` PendingBlock. This block is drained by `before_prompt_build`
 *     and injected as `prependContext` in the next turn.
 *  2. **Target conclusion drift detection** (`TARGET_CONCLUSION_CHECK_PROMPT`):
 *     Only executed when the consistency check finds no issues and anchors already contain
 *     targetConclusions + recentSummaries. Responsible for assessing "whether recent work is still
 *     progressing toward the target conclusions", and allows the reviewer to propose up to 2 new
 *     targetConclusions (deduplicated + capacity capped).
 *
 * Design rationale
 *  - **Separation of concerns vs course-corrector**: this class only evaluates "recent consistency
 *    + target progress", and does not directly trigger force-regenerate. Session-level deviation
 *    scoring / forced regeneration is the sole responsibility of CourseCorrector during the llm_output
 *    phase, avoiding ambiguity in deviationScore definitions across two locations.
 *  - All corrections are enqueued as PendingBlocks and drained by `before_prompt_build`.
 *  - **Dual-mode conversation context construction** (_buildConversationContext):
 *      • Short context (≤ SAFE_NO_TRUNCATE_LIMIT chars): fully preserved to give the reviewer maximum fidelity.
 *      • Long context + has summaries: replace assistant messages with structured summaries via
 *        findMatchingSummary, compressing tokens while retaining the semantic skeleton.
 *      • Long context but missing summaries: degrade to hard truncation by character count (worst path,
 *        still yields a conclusion).
 *  - **suggestedNewTargets cap and deduplication**: prevents the reviewer from infinitely expanding
 *    the target list across multiple turns; hard cap of 2 per turn + normalized deduplication +
 *    global 15-entry FIFO.
 *  - **Fail silently**: if the reviewer is unavailable or any exception occurs, return an empty patch
 *    and never block the main LLM call.
 */

import type { SupervisorConfig, PluginLogger, TurnState } from '../core/types.js';
import type { SessionAnchors } from '../core/session-anchors.js';
import { SessionAnchorsRegistry } from '../core/session-anchors.js';
import { ReviewerClient } from '../client/reviewer.js';
import { AuditLogService } from '../core/audit-log.js';
import { CONSISTENCY_CHECK_SYSTEM_PROMPT, TARGET_CONCLUSION_CHECK_PROMPT } from '../core/prompts.js';
import { isCourseCorrectionActive } from '../core/config.js';
import { messageContentToPlainText, truncateMessagePlainText } from '../utils/message-content.js';
import { buildAnchorContextLines } from '../utils/anchor-context.js';
import { findMatchingSummary } from '../utils/summary-matcher.js';
import { validateConsistencyResult, validateTargetConclusionCheck } from '../core/validators.js';


/**
 * When the total plain-text length of the last 10 messages does not exceed this threshold,
 * feed the full original text to the reviewer without any truncation. 8000 characters roughly
 * corresponds to a ~2k token input, which is safe for the vast majority of reviewer models;
 * beyond this threshold, the structured summary / hard truncation fallback path is activated.
 */
const SAFE_NO_TRUNCATE_LIMIT = 8000;

export class ConsistencyChecker {
  private config: SupervisorConfig;
  private logger: PluginLogger;
  private reviewerClient: ReviewerClient;
  private auditLog: AuditLogService;

  constructor(
    config: SupervisorConfig,
    logger: PluginLogger,
    reviewerClient: ReviewerClient,
    auditLog: AuditLogService,
  ) {
    this.config = config;
    this.logger = logger;
    this.reviewerClient = reviewerClient;
    this.auditLog = auditLog;
  }

  updateConfig(config: SupervisorConfig): void {
    this.config = config;
  }

  /**
   * Entry point: check recent conversation consistency and return correction text if necessary.
   *
   * Returns:
   *  - `{}`: no consistency issues detected.
   *  - `{ correctionText: string }`: a consistency correction should be injected into the next
   *    `before_prompt_build` via `enqueueBlock({ type: 'consistencyCorrection', text })`.
   *
   * Bypass logic: when the consistency check finds no issues, it also runs _checkTargetConclusions,
   * so the "whether we are still progressing toward the goal" assessment only happens when there is no more pressing consistency problem.
   */
  async checkConsistency(
    messages: Array<{ role: string; content: unknown }>,
    turn: TurnState,
    anchors: Readonly<SessionAnchors>,
    registry: SessionAnchorsRegistry,
  ): Promise<{ correctionText?: string }> {
    if (!isCourseCorrectionActive(this.config)) return {};

    try {
      const conversationText = this._buildConversationContext(messages, anchors);
      const contextParts = buildAnchorContextLines(anchors);

      // Session Context first, Recent Messages after: let the reviewer see "constraints" before "facts".
      const rawContent = contextParts.length > 0
        ? `## Session Context\n${contextParts.join('\n')}\n\n## Recent Messages\n${conversationText}`
        : conversationText;
      const userContent = `<user_content>\n${rawContent}\n</user_content>`;

      const raw = await this.reviewerClient.review<Record<string, unknown>>(
        CONSISTENCY_CHECK_SYSTEM_PROMPT,
        userContent,
      );
      const result = validateConsistencyResult(raw);

      // No issue → also check targetConclusion progress, then return empty.
      if (!result || !result.hasIssue) {
        await this._checkTargetConclusions(turn, anchors, registry);
        return {};
      }

      this.auditLog.record({
        sessionId: turn.sessionId,
        type: 'consistency_check',
        action: 'warn',
        details: result.details.join('; '),
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });

      if (result.correction) {
        return { correctionText: result.correction };
      }

      return {};
    } catch (err) {
      // Consistency check failures should be silent: never block the main LLM due to review pipeline issues.
      this.logger.error(`Consistency check failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /**
   * Build the "recent conversation" text fed to the reviewer, with three fallback tiers:
   *  - Path A (short): full original text, no truncation — consistency judgment is sensitive to original wording, so avoid truncating when possible.
   *  - Path B (long + no summaries): hard truncate each message to 500/800 characters — worst path, but still functional.
   *  - Path C (long + has summaries): replace assistant messages with structured summaries, truncate user messages to 800 characters
   *      — compresses tokens while retaining the key skeleton of claims/decisions/negations.
   */
  private _buildConversationContext(
    messages: Array<{ role: string; content: unknown }>,
    anchors: Readonly<SessionAnchors>,
  ): string {
    const recentMessages = messages.slice(-10);
    const summaries = anchors.recentSummaries;

    const plainTexts = recentMessages.map((m) => messageContentToPlainText(m.content));
    const totalChars = plainTexts.reduce((sum, t) => sum + t.length, 0);

    // Path A: short context, use original text.
    if (totalChars <= SAFE_NO_TRUNCATE_LIMIT) {
      return recentMessages
        .map((m, i) => `[${m.role}]: ${plainTexts[i]}`)
        .join('\n\n');
    }

    // Path B: long context but missing summaries, hard truncate by character count.
    if (summaries.length === 0) {
      return recentMessages
        .map((m, i) => `[${m.role}]: ${truncateMessagePlainText(plainTexts[i], 500)}`)
        .join('\n\n');
    }

    // Path C: long context + has summaries, compress by role.
    const parts: string[] = [];
    for (let i = 0; i < recentMessages.length; i++) {
      const msg = recentMessages[i];
      const plain = plainTexts[i];

      if (msg.role === 'user') {
        // User messages retain more original text (800 chars), because reviewer needs to see the user's latest intent.
        parts.push(`[user]: ${truncateMessagePlainText(plain, 800)}`);
      } else if (msg.role === 'assistant') {
        // Prefer structured summaries over original text; fall back to truncation if no match.
        const summary = findMatchingSummary(plain, summaries);
        if (summary) {
          const summaryParts: string[] = [];
          if (summary.claims.length > 0) summaryParts.push(`Claims: ${summary.claims.join('; ')}`);
          if (summary.decisions.length > 0) summaryParts.push(`Decisions: ${summary.decisions.join('; ')}`);
          if (summary.references.length > 0) summaryParts.push(`Refs: ${summary.references.join('; ')}`);
          if (summary.conditions.length > 0) summaryParts.push(`If: ${summary.conditions.join('; ')}`);
          if (summary.reasoning.length > 0) summaryParts.push(`Reasoning: ${summary.reasoning.join('; ')}`);
          if (summary.limitations.length > 0) summaryParts.push(`Limits: ${summary.limitations.join('; ')}`);
          if (summary.negations.length > 0) summaryParts.push(`Not: ${summary.negations.join('; ')}`);
          if (summary.nextSteps.length > 0) summaryParts.push(`Next: ${summary.nextSteps.join('; ')}`);
          parts.push(`[assistant]: ${summaryParts.join(' | ')}`);
        } else {
          parts.push(`[assistant]: ${truncateMessagePlainText(plain, 500)}`);
        }
      } else {
        // system / tool and other roles get minimal truncation of 300 characters.
        parts.push(`[${msg.role}]: ${truncateMessagePlainText(plain, 300)}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Sub-check: target conclusion drift.
   *
   * Only executed when both prerequisites are met:
   *  - targetConclusions already exist (otherwise there is no "target" to compare against);
   *  - recentSummaries are available (otherwise there is no "recent work" to measure).
   *
   * Output handling:
   *  - driftDetected: stuff the correction description into a driftCorrection block, to be consumed by course-corrector
   *    during the before_prompt_build phase.
   *  - suggestedNewTargets: hard cap of 2 entries + normalized deduplication + global 15-entry FIFO.
   */
  private async _checkTargetConclusions(
    turn: TurnState,
    anchors: Readonly<SessionAnchors>,
    registry: SessionAnchorsRegistry,
  ): Promise<void> {
    if (anchors.targetConclusions.length === 0) return;
    if (anchors.recentSummaries.length === 0) return;

    try {
      const recentWorkSummary = anchors.recentSummaries
        .slice(-5)
        .map((s) => {
          const parts: string[] = [];
          if (s.claims.length > 0) parts.push(`Claims: ${s.claims.join('; ')}`);
          if (s.decisions.length > 0) parts.push(`Decisions: ${s.decisions.join('; ')}`);
          if (s.conditions.length > 0) parts.push(`If: ${s.conditions.join('; ')}`);
          if (s.limitations.length > 0) parts.push(`Limits: ${s.limitations.join('; ')}`);
          if (s.negations.length > 0) parts.push(`Not: ${s.negations.join('; ')}`);
          if (s.nextSteps.length > 0) parts.push(`Next: ${s.nextSteps.join('; ')}`);
          return parts.join(' | ');
        })
        .join('\n');

      const contextParts: string[] = [];
      if (anchors.researchGoal) {
        contextParts.push(`Research goal: ${anchors.researchGoal}`);
      }
      contextParts.push(`Target conclusions: ${anchors.targetConclusions.join('\n- ')}`);
      if (anchors.methodologyDecisions.length > 0) {
        contextParts.push(`Established methodology decisions: ${anchors.methodologyDecisions.join('; ')}`);
      }
      contextParts.push(`Recent work:\n${recentWorkSummary}`);

      const rawContent = contextParts.join('\n\n');
      const userContent = `<user_content>\n${rawContent}\n</user_content>`;

      const raw = await this.reviewerClient.review<Record<string, unknown>>(
        TARGET_CONCLUSION_CHECK_PROMPT,
        userContent,
      );
      const result = validateTargetConclusionCheck(raw);

      if (!result) return;

      this.auditLog.record({
        sessionId: turn.sessionId,
        type: 'consistency_check',
        action: result.driftDetected ? 'warn' : 'info',
        details: result.progressAssessment,
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });

      if (result.driftDetected && result.driftDetails) {
        const text =
          `Possible drift from target conclusions. ${result.driftDetails}. Unaddressed targets: ${result.unaddressedTargets.join('; ')}`;
        registry.enqueueBlock(turn.sessionId, { type: 'driftCorrection', text });
      }

      // suggestedNewTargets triple protection:
      //  1) At most 2 new entries per turn (capNew) — prevents the reviewer from repeatedly "suggesting new targets" and infinitely expanding the list;
      //  2) trim+lowercase normalized deduplication — avoids duplicate entries caused by case/space differences;
      //  3) Global FIFO cap of 15 entries — controls anchor size, older entries naturally fall out.
      if (result.suggestedNewTargets && result.suggestedNewTargets.length > 0) {
        const staged = turn.stagedAnchorUpdates;
        if (!staged.targetConclusions) staged.targetConclusions = [];
        const normKey = (s: string) => s.trim().toLowerCase();
        const existing = new Set(staged.targetConclusions.map(normKey));
        const capNew = 2;
        let added = 0;
        for (const target of result.suggestedNewTargets) {
          if (added >= capNew) break;
          const n = normKey(target);
          if (!n || existing.has(n)) continue;
          existing.add(n);
          staged.targetConclusions.push(target);
          added += 1;
        }
        if (staged.targetConclusions.length > 15) {
          staged.targetConclusions = staged.targetConclusions.slice(-15);
        }
      }
    } catch (err) {
      this.logger.error(`Target conclusion check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
