/**
 * Dual Model Supervisor — CourseCorrector (`llm_output` + `before_prompt_build` hooks)
 *
 * Responsibilities
 *  1. **Session-level deviation analysis** (`analyzeSession` → `_doAnalyze`, runs at the `llm_output` stage):
 *     Calls the reviewer with SESSION_ANALYSIS_SYSTEM_PROMPT to produce session-level assessments
 *     (deviation / qualityScore / courseCorrection). When deviation exceeds the threshold:
 *       - Enqueues a `driftCorrection` block (prepended next turn as a soft reminder);
 *       - If force-regenerate is enabled and the limit has not been reached, enqueues a `forceRegenerate`
 *         block and sets `turn.shouldRegenerate = true` — the block is the sole source of prepend
 *         data; the flag is only a signal for the message_sending handler to intercept output.
 *  2. **Prepend context injection** (`buildContextInjection`, runs at the `before_prompt_build` stage):
 *     Expands the list of PendingBlocks drained from SessionAnchorsRegistry (lostMemory / consistencyCorrection /
 *     driftCorrection / previousReview / forceRegenerate) into a prependContext string, which the gateway injects at the
 *     beginning of the system segment for the next LLM call.
 *
 * Design rationale
 *  - **deviation is owned exclusively by this class**: OutputReviewer.deepReview also returns a
 *    deviationScore, but only as a single-turn quality reference, **not** to trigger force-regenerate;
 *    session-level deviation = multi-turn trend = this class's responsibility.
 *  - **Single source of truth**: the forceRegenerate block is the authoritative source of prepend data;
 *    `turn.shouldRegenerate` is merely a boolean signal for the message_sending interception.
 *  - **`isTurnFinished` guard**: all branches that may write turn state first check phase==='sent',
 *    preventing pollution of the next turn when async analysis returns after the current turn has ended.
 *  - **regenerateHistory**: synchronously pushes a `regenerating` entry each time prepend is constructed;
 *    OutputReviewer uses history.length to calculate "which regeneration attempt this is", and releases
 *    the final output when maxAttempts is exceeded (avoiding infinite loops).
 *  - **buildRegenerationSummary** is for dashboard / audit display only and does not participate in flow control.
 */

import type { SupervisorConfig, PluginLogger, TurnState, RegenerateHistoryEntry } from '../core/types.js';
import type { SessionAnchors, PendingBlock } from '../core/session-anchors.js';
import { SessionAnchorsRegistry } from '../core/session-anchors.js';
import { ReviewerClient } from '../client/reviewer.js';
import { AuditLogService } from '../core/audit-log.js';
import { SESSION_ANALYSIS_SYSTEM_PROMPT } from '../core/prompts.js';
import { isCourseCorrectionActive, isSupervisorActive, isForceRegenerateActive } from '../core/config.js';
import { buildAnchorContextLines } from '../utils/anchor-context.js';
import { validateDeviationAnalysis } from '../core/validators.js';

function isTurnFinished(turn: TurnState): boolean {
  return (turn.phase as string) === 'sent';
}

interface SessionAnalysisResult {
  deviation: number;
  memoryLoss: boolean;
  qualityScore: number;
  courseCorrection: string;
  summary: string;
  /** Populated by merged prompt when deviation > threshold; empty string otherwise. */
  correctionInstruction: string;
  /** Populated by merged prompt when deviation > threshold; empty string otherwise. */
  deviationSummary: string;
}

export class CourseCorrector {
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
   * Awaiting entry point: runs session-level deviation analysis.
   * Returns a Promise that resolves when analysis completes (or fails gracefully).
   * Callers in `llm_output` should `await` this to ensure shouldRegenerate
   * is set before `message_sending` runs.
   */
  analyzeSession(turn: TurnState, anchors: Readonly<SessionAnchors>, registry: SessionAnchorsRegistry): Promise<void> {
    if (!isCourseCorrectionActive(this.config)) return Promise.resolve();

    return this._doAnalyze(turn, anchors, registry);
  }

  private async _doAnalyze(
    turn: TurnState,
    anchors: Readonly<SessionAnchors>,
    registry: SessionAnchorsRegistry,
  ): Promise<void> {
    try {
      if (isTurnFinished(turn)) {
        this.logger.warn(
          `[CourseCorrector] turn ${turn.turnId} already finished before analysis; skipping.`,
        );
        return;
      }

      // Assemble session-level context: anchors + latest 3 review feedback items + latest assistant output + latest 5 work summaries.
      // Feed review feedback to the reviewer as well, so it can sense "whether these issues have been repeatedly pointed out before",
      // thereby giving a higher deviation score for persistent drift.
      const contextParts = buildAnchorContextLines(anchors);

      if (anchors.recentReviewReports.length > 0) {
        contextParts.push(
          `Recent supervisor review feedback (may repeat if issues persist):\n${anchors.recentReviewReports.slice(-3).join('\n---\n')}`,
        );
      }

      if (turn.turnLlmOutput?.trim()) {
        contextParts.push(`Latest assistant output:\n${turn.turnLlmOutput.slice(0, 12_000)}`);
      }

      // Merge staged summaries from Step 1 with historical summaries for context.
      // Step 1's extractSummary result lives in turn.stagedAnchorUpdates.recentSummaries;
      // historical summaries are in anchors.recentSummaries.
      const allSummaries = [
        ...anchors.recentSummaries,
        ...(turn.stagedAnchorUpdates.recentSummaries ?? []),
      ];
      if (allSummaries.length > 0) {
        const summaryText = allSummaries
          .slice(-5)
          .map((s) => {
            const parts: string[] = [];
            if (s.claims.length > 0) parts.push(`Claims: ${s.claims.join('; ')}`);
            if (s.decisions.length > 0) parts.push(`Decisions: ${s.decisions.join('; ')}`);
            return parts.join(' | ');
          })
          .join('\n---\n');
        contextParts.push(`Recent work summaries:\n${summaryText}`);
      }

      const rawContent = contextParts.length > 0
        ? contextParts.join('\n\n')
        : 'No session context available for analysis.';
      const userContent = `<user_content>\n${rawContent}\n</user_content>`;

      const raw = await this.reviewerClient.review<Record<string, unknown>>(
        SESSION_ANALYSIS_SYSTEM_PROMPT,
        userContent,
      );
      const result = validateDeviationAnalysis(raw);

      if (!result) return;

      this.auditLog.record({
        sessionId: turn.sessionId,
        type: 'session_analysis',
        action: result.deviation > this.config.courseCorrection.deviationThreshold ? 'warn' : 'info',
        details: result.summary ?? `Deviation: ${result.deviation.toFixed(2)}, Quality: ${result.qualityScore.toFixed(2)}`,
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });

      if (isTurnFinished(turn)) {
        this.logger.warn(
          `[CourseCorrector] turn ${turn.turnId} already finished; skipping course-correction write.`,
        );
        return;
      }

      // ── Deviation exceeds threshold → inject driftCorrection (soft reminder) + optional forceRegenerate (hard regeneration) ──
      if (result.deviation > this.config.courseCorrection.deviationThreshold && result.courseCorrection) {
        // Soft path: driftCorrection is always enqueued; a reminder is prepended next turn.
        registry.enqueueBlock(turn.sessionId, { type: 'driftCorrection', text: result.courseCorrection });

        if (isForceRegenerateActive(this.config)) {
          const maxAttempts = this.config.courseCorrection.maxRegenerateAttempts;
          const attempts = turn.regenerateHistory.length;
          if (attempts < maxAttempts) {
            // Hard path (merged): correctionInstruction + deviationSummary are already in result
            // from the single merged SESSION_ANALYSIS_SYSTEM_PROMPT call — no second LLM round-trip needed.
            const instruction = result.correctionInstruction || result.courseCorrection;
            const deviationSummary = result.deviationSummary || result.summary;

            if (instruction && !isTurnFinished(turn)) {
              const originalPreview = turn.turnLlmOutput
                ? turn.turnLlmOutput.slice(0, 200)
                : '(no output captured)';

              turn.shouldRegenerate = true;

              registry.enqueueBlock(turn.sessionId, {
                type: 'forceRegenerate',
                deviationScore: result.deviation,
                correctionInstruction: instruction,
                originalOutputPreview: originalPreview,
              });

              this.auditLog.record({
                sessionId: turn.sessionId,
                type: 'force_regenerate',
                action: 'block',
                details: `Deviation ${result.deviation.toFixed(2)} triggered force regeneration (attempt ${attempts + 1}/${maxAttempts}): ${deviationSummary}`,
                metadata: JSON.stringify({ correctionInstruction: instruction, deviationSummary }),
                timestamp: Date.now(),
              });
            }
          } else {
            this.auditLog.record({
              sessionId: turn.sessionId,
              type: 'force_regenerate',
              action: 'warn',
              details: `Max regeneration attempts (${maxAttempts}) reached. Deviation persists at ${result.deviation.toFixed(2)}.`,
              timestamp: Date.now(),
            });
          }
        }
      }

      if (result.memoryLoss) {
        this.auditLog.record({
          sessionId: turn.sessionId,
          type: 'course_correction',
          action: 'warn',
          details: 'Session analysis detected potential memory loss',
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.logger.error(`Course correction analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Called at the `before_prompt_build` stage: expands the drained PendingBlock list into a
   * prepend text, which the gateway injects at the beginning of the system message for the next LLM call.
   */
  buildContextInjection(turn: TurnState, drained: PendingBlock[]): { prependContext?: string } {
    if (!isSupervisorActive(this.config)) return {};

    const lines: string[] = [];

    for (const block of drained) {
      if (block.type === 'lostMemory') {
        lines.push('[Supervisor] ⚠️ Context compaction may have lost the following key information. Refer to it:');
        lines.push(block.text);
        lines.push('');
      } else if (block.type === 'consistencyCorrection') {
        lines.push('[Supervisor] ⚠️ Consistency issue detected in recent conversation. Please address:');
        lines.push(block.text);
        lines.push('');
      } else if (block.type === 'driftCorrection') {
        lines.push('[Supervisor] 🧭 Drift detected in the previous turn. Please note:');
        lines.push(block.text);
        lines.push('');
      } else if (block.type === 'previousReview') {
        // previousReview is enqueued by OutputReviewer; the text already contains full prompt wrapping, output as-is.
        lines.push(block.text);
        lines.push('');
      } else if (block.type === 'forceRegenerate') {
        lines.push(...this._linesForForceRegenerate(turn, block));
      }
    }

    if (lines.length === 0) return {};

    return { prependContext: lines.join('\n') };
  }

  /**
   * Construct forceRegenerate prepend from a drained block, and push a 'regenerating' entry
   * into turn.regenerateHistory.
   * OutputReviewer uses history.length to calculate "which regeneration attempt this is" and decides whether to release the final output.
   */
  private _linesForForceRegenerate(turn: TurnState, block: Extract<PendingBlock, { type: 'forceRegenerate' }>): string[] {
    const lines: string[] = [];
    const maxAttempts = this.config.courseCorrection.maxRegenerateAttempts;
    const attempts = turn.regenerateHistory.length;
    const remaining = maxAttempts - attempts;

    lines.push('[Supervisor] 🚫 Your previous output was BLOCKED because it deviated from the research goal.');
    lines.push(`[Supervisor] Deviation score: ${block.deviationScore.toFixed(2)} (threshold: ${this.config.courseCorrection.deviationThreshold})`);
    lines.push(`[Supervisor] Regeneration attempt ${attempts + 1} of ${maxAttempts}. ${remaining > 0 ? `${remaining} attempt(s) remaining.` : 'This is the final attempt.'}`);
    lines.push('');
    lines.push('[Supervisor] You MUST regenerate your output following this correction:');
    lines.push(block.correctionInstruction);
    lines.push('');
    lines.push('[Supervisor] Your previous deviated output (for reference — do NOT repeat it):');
    lines.push(block.originalOutputPreview);
    lines.push('');
    lines.push('[Supervisor] IMPORTANT: Do NOT simply rephrase the previous output. Address the specific issues identified and ensure your response aligns with the research goal.');

    const historyEntry: RegenerateHistoryEntry = {
      attempt: attempts + 1,
      timestamp: Date.now(),
      deviationScore: block.deviationScore,
      originalOutputPreview: block.originalOutputPreview,
      correctionInstruction: block.correctionInstruction,
      result: 'regenerating',
    };
    turn.regenerateHistory.push(historyEntry);

    return lines;
  }

  /**
   * For dashboard / audit display only: aggregates all regeneration history for this turn into a readable text.
   * Does not participate in any flow-control decisions.
   */
  buildRegenerationSummary(turn: TurnState): string {
    if (turn.regenerateHistory.length === 0) return '';

    const lines: string[] = [];
    lines.push('📋 [Supervisor] Regeneration Summary');
    lines.push(`Total regeneration attempts: ${turn.regenerateHistory.length}`);
    lines.push('');

    for (const entry of turn.regenerateHistory) {
      const status = entry.result === 'max_reached' ? '❌ Max reached' :
                     entry.result === 'corrected' ? '✅ Corrected' :
                     '🔄 Regenerating';
      lines.push(`  Attempt ${entry.attempt}: deviation=${entry.deviationScore.toFixed(2)} — ${status}`);
      if (entry.originalOutputPreview) {
        lines.push(`    Output preview: ${entry.originalOutputPreview.slice(0, 100)}...`);
      }
    }

    const lastEntry = turn.regenerateHistory[turn.regenerateHistory.length - 1];
    if (lastEntry) {
      if (lastEntry.result === 'max_reached') {
        lines.push('');
        lines.push('⚠️ Maximum regeneration attempts reached. The output may still deviate from the research goal.');
      } else if (lastEntry.result === 'corrected') {
        lines.push('');
        lines.push('✅ Output was successfully corrected after regeneration.');
      }
    }

    return lines.join('\n');
  }
}
