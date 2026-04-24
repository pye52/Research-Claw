/**
 * Dual Model Supervisor — SummaryExtractor (`llm_output` hook)
 *
 * Responsibilities
 *  - After the assistant output is generated, compress it into a structured MessageSummary:
 *      claims / decisions / decisionKinds / references / conditions /
 *      reasoning / limitations / negations / nextSteps.
 *  - Append the summary to `turn.stagedAnchorUpdates.recentSummaries`, and route the
 *    "decisions" within it into two anchor sequences: keyConclusions and methodologyDecisions.
 *
 * Design rationale
 *  - **Structured summaries replace raw text**: consistency-checker and memory-guardian use
 *    summaries instead of raw text for matching / truncation in long sessions; structured fields
 *    are easier to compare stably than a blob of summary text ("I said X is not possible" →
 *    directly hits negations).
 *  - **decisionKinds classification → anchor routing**: the reviewer directly tags each decision
 *    with a kind (methodology / fact / preference / …); when it hits methodology it is also
 *    written to methodologyDecisions; when kinds are absent, fall back to local regex
 *    (METHODOLOGY_FALLBACK_RE).
 *  - **Deduplication + capacity cap**: keyConclusions and methodologyDecisions both have
 *    ANCHOR_CAPS limits, truncated FIFO when exceeded; recentSummaries itself also has
 *    MAX_STORED_SUMMARIES.
 *  - **Fallback summary**: when the reviewer is unavailable or throws, write a placeholder claim
 *    with the first 300 chars of output, ensuring recentSummaries has no "empty turns" and
 *    downstream matching does not break.
 *  - **Per-turn staging semantics same as GoalParser**: write to staging this turn, merge
 *    uniformly on message_sending.
 */

import type { MessageSummary, SupervisorConfig, PluginLogger, TurnState } from '../core/types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { AuditLogService } from '../core/audit-log.js';
import { SUMMARY_EXTRACTION_SYSTEM_PROMPT } from '../core/prompts.js';
import { isSupervisorActive } from '../core/config.js';
import { ANCHOR_CAPS } from '../core/session-anchors.js';
import { validateMessageSummary } from '../core/validators.js';

/**
 * When the reviewer does not provide decisionKinds, this regex serves as the fallback
 * for determining whether a decision is a methodology decision.
 * Intentionally conservative: must contain both a verb like use/adopt/decide/choose/select
 * **and** a noun like method/methodology/approach/technique, to avoid classifying general
 * statements as methodology.
 */
const METHODOLOGY_FALLBACK_RE =
  /(use|adopt|decide|choose|select).*?(method|methodology|approach|technique)/i;

/**
 * Local capacity cap for recentSummaries.
 * 10 is chosen because consistency-checker and course-corrector typically only look back
 * at .slice(-3) ~ .slice(-5); keeping 10 is enough to cover recent turns while controlling
 * anchor size.
 */
const MAX_STORED_SUMMARIES = 10;

export class SummaryExtractor {
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
   * Awaiting entry point: extracts a structured summary from the output.
   * Returns a Promise that resolves when extraction completes (or fails gracefully).
   * Callers in `llm_output` should `await` this to ensure summaries are available
   * before `message_sending` runs.
   */
  extractSummary(output: string, turn: TurnState): Promise<void> {
    if (!isSupervisorActive(this.config)) return Promise.resolve();

    return this._doExtract(output, turn);
  }

  private async _doExtract(output: string, turn: TurnState): Promise<void> {
    try {
      const userContent = `<user_content>\n${output}\n</user_content>`;
      const raw = await this.reviewerClient.review<Record<string, unknown>>(
        SUMMARY_EXTRACTION_SYSTEM_PROMPT,
        userContent,
      );
      const result = validateMessageSummary(raw);

      // Async race condition: this turn has already been sent / finished, skip writing to staging
      // (avoid polluting the next turn's anchor merge).
      if (turn.phase === 'sent') {
        this.logger.warn(`[SummaryExtractor] turn ${turn.turnId} already finished; skipping summary write.`);
        return;
      }

      // Reviewer unavailable → write a fallback placeholder to ensure recentSummaries has no empty turns.
      if (!result) {
        this._storeFallbackSummary(output, turn);
        return;
      }

      // Fill any potentially missing fields with empty arrays so downstream can safely use `.length` / `.join()`.
      const enriched: MessageSummary = {
        claims: result.claims ?? [],
        decisions: result.decisions ?? [],
        decisionKinds: result.decisionKinds,
        references: result.references ?? [],
        conditions: result.conditions ?? [],
        reasoning: result.reasoning ?? [],
        limitations: result.limitations ?? [],
        negations: result.negations ?? [],
        nextSteps: result.nextSteps ?? [],
      };

      // ── 1. Write to recentSummaries (FIFO, local cap MAX_STORED_SUMMARIES) ───
      const staged = turn.stagedAnchorUpdates;
      if (!staged.recentSummaries) staged.recentSummaries = [];
      staged.recentSummaries.push(enriched);
      if (staged.recentSummaries.length > MAX_STORED_SUMMARIES) {
        staged.recentSummaries = staged.recentSummaries.slice(-MAX_STORED_SUMMARIES);
      }

      // ── 2. Decision routing: keyConclusions / methodologyDecisions ─────────
      //
      //  Subset relationship: methodologyDecisions ⊆ keyConclusions
      //
      //   keyConclusions              methodologyDecisions
      //   ┌────────────────────────┐  ┌────────────────────────┐
      //   │ "Adopt quantitative"   │◄─│ "Adopt quantitative"   │  ← subset
      //   │ "Use COCO dataset"     │  └────────────────────────┘
      //   │ "Confirmed 3 core"     │
      //   └────────────────────────┘
      //
      // Design intent:
      //  - keyConclusions carries the panoramic view of "all confirmed conclusions"; downstream
      //    (e.g. anchor-context's "Key conclusions reached:") needs completeness to prevent LLM
      //    self-contradiction.
      //  - methodologyDecisions is a dedicated constraint line, only collecting methodology-class
      //    decisions; downstream (e.g. drift detection, prompt's "Established methodology decisions:")
      //    only cares about methodology, not disturbed by factual conclusions.
      //  - Both sequences independently apply FIFO + deduplication + capacity cap, without affecting
      //    each other.
      //
      if (enriched.decisions.length > 0) {
        if (!staged.keyConclusions) staged.keyConclusions = [];
        if (!staged.methodologyDecisions) staged.methodologyDecisions = [];

        // useKinds requires kinds and decisions to correspond one-to-one; otherwise drop the kind signal and fall back to regex.
        const kinds = enriched.decisionKinds;
        const useKinds = kinds && kinds.length === enriched.decisions.length;

        for (let i = 0; i < enriched.decisions.length; i += 1) {
          const decision = enriched.decisions[i]!;
          const kind = useKinds ? kinds[i] : undefined;

          // Step 1: unconditionally write — all decisions (including methodology) go into keyConclusions.
          if (!staged.keyConclusions.includes(decision)) {
            staged.keyConclusions.push(decision);
          }
          if (staged.keyConclusions.length > ANCHOR_CAPS.conclusions) {
            staged.keyConclusions = staged.keyConclusions.slice(-ANCHOR_CAPS.conclusions);
          }

          // Step 2: conditional write — only methodology-class decisions additionally enter methodologyDecisions
          // (forms a subset relationship with keyConclusions, not mutually exclusive).
          //  - Prefer the kind provided by the reviewer;
          //  - When no kind is available, fall back to local regex (conservative, to avoid false positives).
          const isMethodology =
            kind === 'methodology' ||
            (!useKinds && METHODOLOGY_FALLBACK_RE.test(decision));
          if (isMethodology && !staged.methodologyDecisions.includes(decision)) {
            staged.methodologyDecisions.push(decision);
            if (staged.methodologyDecisions.length > ANCHOR_CAPS.methodologyDecisions) {
              staged.methodologyDecisions = staged.methodologyDecisions.slice(-ANCHOR_CAPS.methodologyDecisions);
            }
          }
        }
      }

      this.auditLog.record({
        sessionId: turn.sessionId,
        type: 'output_review',
        action: 'info',
        details: `summary_extracted: claims=${enriched.claims.length}, decisions=${enriched.decisions.length}, refs=${enriched.references.length}, conditions=${enriched.conditions.length}, reasoning=${enriched.reasoning.length}, limitations=${enriched.limitations.length}, negations=${enriched.negations.length}, nextSteps=${enriched.nextSteps.length}`,
        timestamp: Date.now(),
      });
    } catch (err) {
      // Exception → also write fallback to ensure downstream summary-matcher does not break due to missing summaries.
      this.logger.error(`Summary extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      if (turn.phase !== 'sent') {
        this._storeFallbackSummary(output, turn);
      }

      this.auditLog.record({
        sessionId: turn.sessionId,
        type: 'output_review',
        action: 'warn',
        details: `summary_extraction_failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Placeholder fallback: stuff the first 300 characters of output into claims, all other fields empty.
   * The main goal is not "content accuracy" but to keep recentSummaries free of gaps —
   * downstream components like findMatchingSummary / consistency-checker can continue to locate by position.
   */
  private _storeFallbackSummary(output: string, turn: TurnState): void {
    const fallbackSummary: MessageSummary = {
      claims: [output.slice(0, 300)],
      decisions: [],
      references: [],
      conditions: [],
      reasoning: [],
      limitations: [],
      negations: [],
      nextSteps: [],
    };
    const staged = turn.stagedAnchorUpdates;
    if (!staged.recentSummaries) staged.recentSummaries = [];
    staged.recentSummaries.push(fallbackSummary);
    if (staged.recentSummaries.length > MAX_STORED_SUMMARIES) {
      staged.recentSummaries = staged.recentSummaries.slice(-MAX_STORED_SUMMARIES);
    }
  }
}
