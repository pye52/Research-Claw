/**
 * Dual Model Supervisor — MemoryGuardian (`before_compaction` / `after_compaction` hooks)
 *
 * Responsibilities
 *  - **beforeCompaction**: before OpenClaw compacts messages, have the reviewer extract
 *    "hard-critical information" (research_goal / key_conclusion / user_preference /
 *    methodology_decision) from the last 20 conversation turns, storing them in
 *    event.preCompactionMemory as a checklist for subsequent verification.
 *  - **afterCompaction**: feed both original and compacted messages to the reviewer to detect
 *    which information was "semantically lost" during compaction; enqueue high-importance
 *    (critical/high) lost items as `lostMemory` blocks, and backfill confirmed lost items
 *    from preCompactionMemory into SessionAnchorsRegistry (research_goal / key_conclusion / …).
 *
 * Design rationale
 *  - **Two-stage pairing**: having the reviewer judge "what was lost" solely from the compacted
 *    text overly relies on the model "guessing the original"; capturing a checklist before
 *    compaction → comparing after compaction → joint dual-signal determination significantly improves accuracy.
 *  - **Importance filtering (critical/high)**: medium-level losses usually don't need to bother
 *    the user, avoiding lostMemory block noise from interfering with the main conversation.
 *  - **Anchors backfill**: items categorized as research_goal etc. in preCompactionMemory are
 *    unconditionally backfilled into anchors, ensuring that even if anchors drift during long
 *    sessions, they can "self-heal" from the pre-compaction snapshot.
 *  - **Summaries over raw text**: when anchors already have recentSummaries, assistant messages
 *    in the original text are replaced with structured summaries, saving tokens and being more
 *    reviewer-friendly.
 */

import type { MemoryItem, MemoryLossItem, SupervisorConfig, PluginLogger } from '../core/types.js';
import type { CompactionEventState } from '../core/compaction-event.js';
import type { SessionAnchors } from '../core/session-anchors.js';
import { SessionAnchorsRegistry } from '../core/session-anchors.js';
import { ReviewerClient } from '../client/reviewer.js';
import { AuditLogService } from '../core/audit-log.js';
import { KEY_MEMORY_IDENTIFICATION_PROMPT, MEMORY_LOSS_DETECTION_PROMPT } from '../core/prompts.js';
import { isMemoryGuardActive } from '../core/config.js';
import { messageContentToPlainText, truncateMessagePlainText } from '../utils/message-content.js';
import { findMatchingSummary } from '../utils/summary-matcher.js';

export class MemoryGuardian {
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
   * `before_compaction` entry point: capture the critical memory checklist before compaction and store it in event.
   * Only takes the last 20 user/assistant messages, up to 12,000 characters per message (covers the vast majority of long outputs).
   */
  async beforeCompaction(
    messages: Array<{ role: string; content: unknown }>,
    event: CompactionEventState,
  ): Promise<void> {
    if (!isMemoryGuardActive(this.config)) return;

    try {
      const conversationText = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-20)
        .map((m) => `[${m.role}]: ${truncateMessagePlainText(m.content, 12_000)}`)
        .join('\n\n');

      const result = await this.reviewerClient.review<{ keyItems: MemoryItem[] }>(
        KEY_MEMORY_IDENTIFICATION_PROMPT,
        conversationText,
      );

      const keyItems = result?.keyItems ?? [];
      event.preCompactionMemory = keyItems;

      if (keyItems.length > 0) {
        this.auditLog.record({
          sessionId: event.sessionId,
          type: 'memory_guard',
          action: 'info',
          details: `Captured ${keyItems.length} memory items before compaction for verification`,
          metadata: JSON.stringify(keyItems.map((k) => ({ category: k.category, summary: k.summary }))),
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.logger.error(`Memory guardian before_compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `after_compaction` entry point: compare original and compacted text to identify "semantic loss".
   *
   * Steps:
   *  1. Concatenate original / compacted text (assistant messages prefer summaries substitution to save tokens);
   *  2. Send preCompactionMemory as a checklist to the reviewer together;
   *  3. Reviewer returns lostItems (semantic matching, not relying on literal substring);
   *  4. Enqueue critical/high lost items as lostMemory blocks, to be prepended next turn;
   *  5. Synchronously backfill entries from preCompactionMemory into anchors (self-healing).
   */
  async afterCompaction(
    original: Array<{ role: string; content: unknown }>,
    compacted: Array<{ role: string; content: unknown }>,
    event: CompactionEventState,
    anchors: Readonly<SessionAnchors>,
    registry: SessionAnchorsRegistry,
  ): Promise<void> {
    if (!isMemoryGuardActive(this.config)) return;

    const sessionId = event.sessionId;

    try {
      const hasSummaries = anchors.recentSummaries.length > 0;

      let originalText: string;
      let compactedText: string;

      // Feed preCompactionMemory explicitly as a "must-verify checklist" to the reviewer,
      // preventing it from answering "what was lost" based solely on intuition.
      const preCompactionChecklist = event.preCompactionMemory.length > 0
        ? `## Key Items to Verify (identified before compaction)\n${event.preCompactionMemory.map((k) => `- [${k.category}] ${k.summary}`).join('\n')
        }\n\n`
        : '';

      if (hasSummaries) {
        const originalParts: string[] = [];
        for (const msg of original.filter((m) => m.role === 'user' || m.role === 'assistant')) {
          if (msg.role === 'user') {
            originalParts.push(`[user]: ${truncateMessagePlainText(msg.content, 2000)}`);
          } else {
            const summary = findMatchingSummary(messageContentToPlainText(msg.content), anchors.recentSummaries);
            if (summary) {
              const summaryStr = [
                summary.claims.length > 0 ? `Claims: ${summary.claims.join('; ')}` : '',
                summary.decisions.length > 0 ? `Decisions: ${summary.decisions.join('; ')}` : '',
                summary.references.length > 0 ? `Refs: ${summary.references.join('; ')}` : '',
              ].filter(Boolean).join(' | ');
              originalParts.push(`[assistant]: ${summaryStr}`);
            } else {
              originalParts.push(`[assistant]: ${truncateMessagePlainText(msg.content, 2000)}`);
            }
          }
        }
        originalText = originalParts.join('\n');

        compactedText = compacted
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => `[${m.role}]: ${truncateMessagePlainText(m.content, 1500)}`)
          .join('\n');
      } else {
        originalText = original
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => `[${m.role}]: ${truncateMessagePlainText(m.content, 1500)}`)
          .join('\n');

        compactedText = compacted
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => `[${m.role}]: ${truncateMessagePlainText(m.content, 1500)}`)
          .join('\n');
      }

      const userContent =
        preCompactionChecklist +
        `## Original Messages\n${originalText}\n\n## Compacted Messages\n${compactedText}`;

      const result = await this.reviewerClient.review<{ lostItems: MemoryLossItem[] }>(
        MEMORY_LOSS_DETECTION_PROMPT,
        userContent,
      );

      const lostItems = result?.lostItems ?? [];

      // Only push critical/high lost items into next turn's prepend; medium items are already prohibited at the prompt stage,
      // this adds an extra filter to avoid noise bothering the user.
      const highPriorityLost = lostItems
        .filter((item) => item.importance === 'critical' || item.importance === 'high');

      if (highPriorityLost.length > 0) {
        const lostMemoryText = highPriorityLost
          .map((item) => `- [${item.category}] ${item.content}`)
          .join('\n');

        registry.enqueueBlock(sessionId, { type: 'lostMemory', text: lostMemoryText });

        this.auditLog.record({
          sessionId,
          type: 'memory_guard',
          action: 'warn',
          details: `Compaction lost ${lostItems.length} items (${lostItems.filter((i) => i.importance === 'critical').length} critical)`,
          metadata: JSON.stringify(lostItems),
          timestamp: Date.now(),
        });

        this.logger.warn(
          `[MemoryGuard] Compaction lost ${lostItems.length} items: ${lostItems.map((i) => `${i.category}(${i.importance})`).join(', ')}`,
        );
      }

      // Route pre-compaction captured critical information back into anchors by category. Even if anchors
      // were overwritten or lost by some abnormal path during a long session, they can be periodically
      // restored to consistency via the compaction cadence.
      // When setting researchGoal, also set goalConfirmed to true (this is a high-confidence signal).
      const keyConclusions: string[] = [];
      const userPreferences: string[] = [];
      const methodologyDecisions: string[] = [];
      let researchGoal: string | undefined;

      for (const item of event.preCompactionMemory) {
        switch (item.category) {
          case 'research_goal': researchGoal = item.summary; break;
          case 'key_conclusion': keyConclusions.push(item.summary); break;
          case 'user_preference': userPreferences.push(item.summary); break;
          case 'methodology_decision': methodologyDecisions.push(item.summary); break;
        }
      }

      const patch: Parameters<SessionAnchorsRegistry['merge']>[1] = {};
      if (researchGoal) {
        patch.researchGoal = researchGoal;
        patch.goalConfirmed = true;
      }
      if (keyConclusions.length > 0) patch.keyConclusions = keyConclusions;
      if (userPreferences.length > 0) patch.userPreferences = userPreferences;
      if (methodologyDecisions.length > 0) patch.methodologyDecisions = methodologyDecisions;

      if (Object.keys(patch).length > 0) {
        registry.merge(sessionId, patch);
      }
    } catch (err) {
      this.logger.error(`Memory guardian after_compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
