/**
 * Dual Model Supervisor — GoalParser (`message_received` hook)
 *
 * Responsibilities
 *  - At the start of every user turn, parse that user message into a structured "research intent":
 *      researchGoal / targetConclusions / methodology / and its relationship to the "current session goal"
 *      (`vsCurrentGoal`: keep / replace / unknown).
 *  - Parsing results are written to `turn.stagedAnchorUpdates` (per-turn staging),
 *    only merged into SessionAnchorsRegistry at the final `message_sending` stage, preventing in-flight state from being read externally.
 *
 * Design rationale
 *  - **Per-turn staging instead of directly writing to anchors**: this turn's parsing results may not align with the final conversation direction
 *    (e.g., the user changes their mind later, or this turn is overridden by force-regenerate). Using staging makes "commit" a single atomic point.
 *  - **Trivial escape hatch**: the reviewer prompt allows returning `researchGoal: ""`, `vsCurrentGoal: "keep"`
 *    for greetings / acknowledgments; this class explicitly skips anchor writes in that case,
 *    so "嗯" / "收到" neither clear the research goal nor overwrite the ongoing research direction.
 *  - **Fallback truncation**: when the reviewer is unavailable, degrade to "first 200 chars" as a weak research goal,
 *    and set goalConfirmed to false so downstream knows this is a low-confidence signal.
 *  - **goalConfirmed**: reviewer parsed a clear goal → true; fallback / default → false.
 *    SessionAnchorsRegistry uses goalConfirmed + jaccardSimilarity during merge to decide keep vs. replace.
 *  - **vsCurrentGoal hint**: pass the reviewer's judgment to the registry via `_goalReplaceHint`,
 *    used as input for the anchors merge strategy (the registry still performs safety validation on the hint;
 *    for example, a "replace" with low similarity may still be rejected).
 */

import type { TaskParsingResult, SupervisorConfig, PluginLogger, TurnState } from '../core/types.js';
import type { GoalReplaceHint } from '../core/session-anchors.js';
import { SessionAnchorsRegistry } from '../core/session-anchors.js';
import { ReviewerClient } from '../client/reviewer.js';
import { AuditLogService } from '../core/audit-log.js';
import { TASK_PARSING_SYSTEM_PROMPT } from '../core/prompts.js';
import { isSupervisorActive } from '../core/config.js';

export class GoalParser {
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
   * Synchronous entry point: fire-and-forget to start an asynchronous parse.
   * Not awaited so as not to block the `message_received` hook; parsing results land in turn.stagedAnchorUpdates,
   * merged / committed during the message_sending stage.
   */
  parseGoal(userMessage: string, turn: TurnState, anchors: SessionAnchorsRegistry): void {
    if (!isSupervisorActive(this.config)) return;

    this._doParse(userMessage, turn, anchors).catch((err) => {
      this.logger.error(`Goal parsing failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async _doParse(
    userMessage: string,
    turn: TurnState,
    anchors: SessionAnchorsRegistry,
  ): Promise<void> {
    try {
      // Feed the "current session goal" into the reviewer's user segment so it can judge vsCurrentGoal=keep/replace.
      // When there is no current goal, give "(none)" to prevent the model from freely improvising.
      const anchorGoal = anchors.view(turn.sessionId).researchGoal?.trim() ?? '';
      const promptUser = anchorGoal.length > 0
        ? `--- Session anchor (current research goal) ---\n${anchorGoal}\n\n${userMessage}`
        : `--- Session anchor (current research goal) ---\n(none)\n\n${userMessage}`;

      const result = await this.reviewerClient.review<TaskParsingResult>(
        TASK_PARSING_SYSTEM_PROMPT,
        promptUser,
      );

      // Async race protection: if this turn has already been sent/finished during parsing, prohibit further staging writes (avoid polluting the next turn).
      if (turn.phase === 'sent') {
        this.logger.warn(`[GoalParser] turn ${turn.turnId} already finished; skipping goal write.`);
        return;
      }

      // Use first 200 chars as a weak signal, and set goalConfirmed=false so the registry knows confidence is low.
      if (!result) {
        this.logger.warn('[GoalParser] Reviewer returned no result, using fallback truncation');
        if (userMessage.length > 10) {
          turn.stagedAnchorUpdates.researchGoal = userMessage.slice(0, 200);
          turn.stagedAnchorUpdates.goalConfirmed = false;
        }
        return;
      }

      // The prompt allows the reviewer to return an empty researchGoal for greetings/pleasantries;
      // this turn does not update the research goal, and the existing anchors.researchGoal remains unchanged.
      if (!result.researchGoal.trim()) {
        this.logger.debug?.('[GoalParser] Trivial or empty researchGoal from parser; skipping anchor goal update.');
        return;
      }

      turn.stagedAnchorUpdates.researchGoal = result.researchGoal;
      turn.stagedAnchorUpdates.goalConfirmed = true;

      if (result.targetConclusions && result.targetConclusions.length > 0) {
        turn.stagedAnchorUpdates.targetConclusions = result.targetConclusions;
      }

      if (result.methodology) {
        turn.stagedAnchorUpdates.methodology = result.methodology;
      }

      // vsCurrentGoal serves only as a "suggestion" for registry merge: the registry still makes the final decision based on similarity,
      // so even if the reviewer says replace, a high similarity may lead to merge rather than replacement.
      const vs = result.vsCurrentGoal;
      if (vs === 'replace' || vs === 'keep' || vs === 'unknown') {
        turn.stagedAnchorUpdates._goalReplaceHint = vs as GoalReplaceHint;
      }

      this.auditLog.record({
        sessionId: turn.sessionId,
        type: 'course_correction',
        action: 'info',
        details: `Research goal parsed: ${result.researchGoal.slice(0, 100)}`,
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });
    } catch (err) {
      // Exception path is treated the same as reviewer returning null: write fallback to keep the turn moving.
      this.logger.error(`Goal parsing failed: ${err instanceof Error ? err.message : String(err)}`);
      if (turn.phase !== 'sent' && userMessage.length > 10) {
        turn.stagedAnchorUpdates.researchGoal = userMessage.slice(0, 200);
        turn.stagedAnchorUpdates.goalConfirmed = false;
      }
    }
  }
}
