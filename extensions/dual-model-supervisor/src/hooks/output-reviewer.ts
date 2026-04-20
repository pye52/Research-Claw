/**
 * Dual Model Supervisor — OutputReviewer (`message_sending` hook)
 *
 * Responsibilities (listed in inspection order / priority)
 *  1. **Force-regenerate interception**: If `turn.forceRegeneratePending` is true (set by
 *     CourseCorrector during the llm_output phase) and maxRegenerateAttempts has not been reached,
 *     replace the entire output with a "🔄 [Supervisor] Output blocked …" prompt (causing the gateway
 *     to trigger regeneration once more).
 *  2. **Idempotency skip**: If the message already contains SUPERVISOR_REVIEW_SUMMARY_MARKER,
 *     a footer has already been appended → pass through directly (avoid duplicate appends during
 *     retries / multiple hook triggers).
 *  3. **QuickChecker synchronous quick check**: If dangerous / privacy rules are hit → replace the
 *     message with a short block prompt.
 *  4. **deepReview**: Invoke the reviewer model for a complete output quality assessment. Results are:
 *      - written to turn.lastReviewReport (for dashboard display);
 *      - pushed into anchors.recentReviewReports and enqueued as a previousReview block,
 *        so the next turn's prepend sees "what the reviewer noted last time".
 *  5. **Footer append (optional)**: Only when attachSummary=true (external channel delivery),
 *     append quick warnings and the deep review report to the end of the message body.
 *     Dashboard messages do not append a footer; they rely on the panel for separate display.
 *
 * Design rationale
 *  - **force-regenerate must happen before all other checks**: once deviation-regeneration is identified,
 *    the entire output should not be shown to the user; quick check / deep review overhead is wasteful
 *    in this case.
 *  - **maxRegenerateAttempts safety net**: avoid infinite loops. When the reviewer persistently flags
 *    deviation, let the user see the "imperfect output" once the limit is exceeded — at least don't
 *    deadlock the conversation.
 *  - **deep review still runs even when attachSummary is false**: so that the review report is written
 *    into anchors and prepared for the next turn's LLM context — this is the key feedback loop for
 *    quality improvement.
 *  - **deepReview failure is non-blocking**: when the reviewer is unavailable, return null, send the
 *    body as normal, and write "Deep review did not return a result..." in the footer to maintain
 *    transparency.
 *  - **deviationScore is for logs / footer display only**: this class does not convert it into a block
 *    decision (that is the session-level deviation responsibility of CourseCorrector).
 */

import type { ReviewResult, SupervisorConfig, PluginLogger, TurnState } from '../core/types.js';
import type { SessionAnchors } from '../core/session-anchors.js';
import { SessionAnchorsRegistry } from '../core/session-anchors.js';
import { ReviewerClient } from '../client/reviewer.js';
import { QuickChecker } from './quick-checker.js';
import { AuditLogService } from '../core/audit-log.js';
import { isForceRegenerateActive } from '../core/config.js';
import { OUTPUT_REVIEW_SYSTEM_PROMPT } from '../core/prompts.js';
import { SUPERVISOR_REVIEW_SUMMARY_MARKER } from './hook-context.js';

/**
 * When the reviewer does not provide reportText, assemble a minimal usable footer from structured fields.
 * deviationScore may be null/undefined (reviewer may omit it); explicitly mapped to "n/a".
 */
function formatDeepReviewForAppend(r: ReviewResult): string {
  const lines: string[] = [];
  if (r.blocked) lines.push('  ⛔ Deep review flagged this output (blocked)');
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  for (const m of r.memoryAlerts) lines.push(`  🧠 ${m}`);
  if (r.correctionNote) lines.push(`  📝 ${r.correctionNote}`);
  const devStr =
    r.deviationScore != null && typeof r.deviationScore === 'number'
      ? r.deviationScore.toFixed(2)
      : 'n/a';
  lines.push(`  (quality ${r.qualityScore.toFixed(2)}, deviation ${devStr})`);
  return lines.join('\n');
}

export class OutputReviewer {
  private config: SupervisorConfig;
  private logger: PluginLogger;
  private reviewerClient: ReviewerClient;
  private quickChecker: QuickChecker;
  private auditLog: AuditLogService;

  constructor(
    config: SupervisorConfig,
    logger: PluginLogger,
    reviewerClient: ReviewerClient,
    quickChecker: QuickChecker,
    auditLog: AuditLogService,
  ) {
    this.config = config;
    this.logger = logger;
    this.reviewerClient = reviewerClient;
    this.quickChecker = quickChecker;
    this.auditLog = auditLog;
  }

  updateConfig(config: SupervisorConfig): void {
    this.config = config;
    this.quickChecker.updateConfig(config);
  }

  /**
   * `message_sending` entry point.
   *
   * Return value contract:
   *  - `null`: keep the original message unchanged (no modification needed).
   *  - Non-null string: replace the original message with this string (block prompt / version with footer appended).
   *
   * options.attachSummary: only passed as true for external channel delivery (when `hook-context` determines isChannelDelivery);
   * Dashboard messages are displayed separately via the panel, not polluting the conversation flow.
   */
  async reviewMessageSending(
    message: string,
    turn: TurnState | undefined,
    anchors: SessionAnchors | undefined,
    registry: SessionAnchorsRegistry | undefined,
    options?: { attachSummary?: boolean },
  ): Promise<string | null> {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      this.logger.warn('[OutputReviewer] Review skipped: disabled or reviewMode=off');
      return null;
    }

    const sessionId = turn?.sessionId ?? 'unknown';

    // ── Priority 1: force-regenerate interception ──────────────────────────
    // Must happen before all other checks. Once hit and limit not reached, the entire output is suppressed;
    // the gateway will re-trigger generation upon receiving this block text (carrying prepend correction instructions).
    if (turn && isForceRegenerateActive(this.config) && turn.forceRegeneratePending) {
      if (turn.regenerateHistory.length < this.config.courseCorrection.maxRegenerateAttempts) {
        const maxAttempts = this.config.courseCorrection.maxRegenerateAttempts;
        const attempt = turn.regenerateHistory.length + 1;
        this.auditLog.record({
          sessionId,
          type: 'force_regenerate',
          action: 'block',
          details: `Output blocked for force regeneration attempt ${attempt}/${maxAttempts}`,
          timestamp: Date.now(),
        });
        const blockMessage = `🔄 [Supervisor] Output blocked — deviation detected. Regenerating corrected content (attempt ${attempt}/${maxAttempts})...`;
        return blockMessage;
      } else {
        // Safety net: avoid infinite regeneration; better to show the user an imperfect output.
        this.logger.warn(`[OutputReviewer] Force regeneration max attempts reached (${this.config.courseCorrection.maxRegenerateAttempts}), allowing output to pass`);
      }
    }

    // ── Priority 2: idempotency skip ──────────────────────────────────
    // Messages that already have a footer appended are not processed again, preventing duplicate appends on multiple hook triggers or retries.
    if (message.includes(SUPERVISOR_REVIEW_SUMMARY_MARKER)) {
      return null;
    }

    // ── Priority 3: QuickChecker synchronous quick check ──────────────────────
    const quickResult = this.quickChecker.check(message);

    if (quickResult.blocked) {
      this.logger.warn(`[OutputReviewer] Quick check blocked: ${quickResult.blockReason}`);
      this.auditLog.record({
        sessionId,
        type: 'output_review',
        action: 'block',
        details: quickResult.blockReason ?? 'Blocked by quick checker',
        timestamp: Date.now(),
      });
      const blockMessage = `⚠️ [Supervisor] Output blocked by review. Reason: ${quickResult.blockReason}`;
      return blockMessage;
    }

    const attachSummary = options?.attachSummary ?? false;

    // ── Priority 4: deepReview ────────────────────────────────
    // Note: even when attachSummary=false (no footer appended), deepReview still runs,
    // because the review report is written into anchors.recentReviewReports and enqueued as a previousReview block,
    // so the next turn's LLM sees "feedback from the last review" — this is the core feedback loop for quality improvement.
    let deep: ReviewResult | null = null;

    if (turn && anchors) {
      deep = await this.deepReview(message, turn, anchors);

      // Before writing to anchors / enqueueing previousReview, confirm this turn is still alive to avoid polluting the next turn.
      if (deep && turn.phase !== 'sent') {
        const reportBody = deep.reportText?.trim()
          ? deep.reportText.trim()
          : formatDeepReviewForAppend(deep);
        turn.lastReviewReport = reportBody;

        if (registry && reportBody.length > 0) {
          registry.pushReviewReport(turn.sessionId, reportBody);
          registry.enqueueBlock(turn.sessionId, {
            type: 'previousReview',
            text: `[Supervisor Last Review] In your previous response, the reviewer noted:\n${reportBody}\nPlease address these points if relevant.`,
          });
        }
      }
    } else {
      this.logger.warn('[OutputReviewer] Deep review skipped: no turn state or anchors');
    }

    if (quickResult.warnings.length > 0) {
      for (const w of quickResult.warnings) {
        this.logger.warn(`[OutputReviewer] Quick check warning: ${w}`);
        this.auditLog.record({
          sessionId,
          type: 'output_review',
          action: 'warn',
          details: w,
          timestamp: Date.now(),
        });
      }
    }

    // ── Priority 5: Footer append (external channels only) ────────────────
    // Dashboard messages are displayed separately via the Supervisor panel; footer is not appended to the conversation flow.
    if (!attachSummary) {
      return null;
    }

    const sections: string[] = [];
    if (quickResult.warnings.length > 0) {
      sections.push(...quickResult.warnings.map((w) => `  ⚠ [Quick] ${w}`));
    }

    if (deep) {
      const reportBody = deep.reportText?.trim()
        ? deep.reportText.trim()
        : formatDeepReviewForAppend(deep);
      sections.push(reportBody);
    } else if (turn) {
      // Intentionally keep fallback text: let the user know the review ran but got no result (transparency > brevity).
      sections.push(
        '  ℹ [Supervisor] Deep review did not return a result (reviewer unavailable, timeout, or parse error). Quick check passed.',
      );
      this.logger.warn('[OutputReviewer] Deep review unavailable, adding fallback message');
    } else {
      sections.push('  ℹ [Supervisor] Deep review was skipped (no turn state). Quick check passed.');
    }

    // SUPERVISOR_REVIEW_SUMMARY_MARKER is injected here; it will be recognized by the "idempotency skip" at the top of this function on the next call.
    const finalMessage = `${message}\n\n---\n${SUPERVISOR_REVIEW_SUMMARY_MARKER}\n${sections.join('\n')}`;
    return finalMessage;
  }

  /**
   * Single-turn deep review: feed anchors (researchGoal / keyConclusions / userPreferences /
   * methodologyDecisions) as `## Context` up front, and the current message to review as
   * `## Output to Review` afterwards, into the reviewer together, so it can assess the quality,
   * warnings, memory loss, etc. of the current message.
   *
   * Failure policy: reviewer unavailable → return null; caller handles fallback (writes a prompt text).
   * Note: force-regenerate is not triggered here directly; deviationScore is used only as a telemetry signal,
   * and session-level deviation determination is the sole responsibility of CourseCorrector.
   */
  async deepReview(message: string, turn: TurnState, anchors: Readonly<SessionAnchors>): Promise<ReviewResult | null> {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      this.logger.warn('[OutputReviewer] Deep review skipped: disabled or reviewMode=off');
      return null;
    }

    const contextParts: string[] = [];
    if (anchors.researchGoal) {
      contextParts.push(`Current research goal: ${anchors.researchGoal}`);
    }
    if (anchors.keyConclusions.length > 0) {
      contextParts.push(`Key conclusions so far: ${anchors.keyConclusions.join('; ')}`);
    }
    if (anchors.userPreferences.length > 0) {
      contextParts.push(`User preferences: ${anchors.userPreferences.join('; ')}`);
    }
    if (anchors.methodologyDecisions.length > 0) {
      contextParts.push(`Methodology decisions: ${anchors.methodologyDecisions.join('; ')}`);
    }

    // ## Context first, ## Output to Review after: reviewer establishes anchors first, then evaluates the current message.
    const userContent = contextParts.length > 0
      ? `## Context\n${contextParts.join('\n\n')}\n\n## Output to Review\n${message}`
      : message;

    const result = await this.reviewerClient.review<ReviewResult>(
      OUTPUT_REVIEW_SYSTEM_PROMPT,
      userContent,
    );

    if (!result) {
      this.logger.warn(`[OutputReviewer] Deep review unavailable for turn ${turn.turnId} (reviewer call failed)`);
      this.auditLog.record({
        sessionId: turn.sessionId,
        type: 'output_review',
        action: 'info',
        details: 'Deep review failed (reviewer unavailable)',
        timestamp: Date.now(),
      });
      return null;
    }

    const action = result.blocked ? 'block' : result.corrected ? 'correct' : result.warnings.length > 0 ? 'warn' : 'pass';

    const devStr =
      result.deviationScore != null && typeof result.deviationScore === 'number'
        ? result.deviationScore.toFixed(2)
        : 'n/a';
    const details = action === 'pass'
      ? `Review passed (quality: ${result.qualityScore.toFixed(2)}, deviation: ${devStr})`
      : result.correctionNote ?? result.warnings.join('; ') ?? 'Review passed';

    this.auditLog.record({
      sessionId: turn.sessionId,
      type: 'output_review',
      action,
      details,
      metadata: JSON.stringify(result),
      timestamp: Date.now(),
    });

    return result;
  }
}
