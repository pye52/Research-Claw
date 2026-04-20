/**
 * Dual Model Supervisor — ToolReviewer (`before_tool_call` hook)
 *
 * Responsibilities
 *  - Performs a "two-stage review" before the main LLM actually issues a tool call:
 *      Stage 1: Local synchronous quick check (QuickChecker.checkToolCall): intercepts fatal
 *               operations like `rm -rf` or writing to `/etc`.
 *      Stage 2: For tools listed in `highRiskTools`, invokes the reviewer model for a semantic
 *               deep review, returning `correctedParams` to rewrite unsafe parameters into safe
 *               versions when necessary.
 *  - Decision result: `{ block, blockReason?, params? }`. Non-empty `params` means the gateway
 *    should continue the call with the corrected parameters.
 *
 * Design rationale
 *  - **Layered fast check and deep inspection**: Obviously dangerous commands can be blocked
 *    within milliseconds without queuing for the remote reviewer. Complex semantic judgments
 *    (e.g. "will this SQL delete the whole table?") are the only cases that warrant a model call.
 *  - **highRisk gating**: Low-risk tools (read, search, etc.) skip deep review to control cost
 *    and latency.
 *  - **correctedParams restricted to safety-related rewrites** (enforced by prompt): this class
 *    does not make tools "better", only "safer" — preventing the reviewer from overreaching into
 *    business parameters.
 *  - **reviewer unavailable = pass**: failures in the review pipeline itself should not block
 *    legitimate user tool calls.
 */

import type { ToolReviewResult, SupervisorConfig, PluginLogger } from '../core/types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { QuickChecker } from './quick-checker.js';
import { AuditLogService } from '../core/audit-log.js';
import { TOOL_REVIEW_SYSTEM_PROMPT } from '../core/prompts.js';

export class ToolReviewer {
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
   * Review once before the tool is actually executed.
   *
   * Flow:
   *  1. Master switch off → pass directly.
   *  2. QuickChecker synchronous hard rules → block on match, no reviewer call.
   *  3. Non-highRisk tools → pass (QuickChecker already covered the critical risks).
   *  4. highRisk tools → invoke reviewer model for deep review, then decide
   *     block / rewrite params / warn / pass based on the return value.
   *
   * Return value contract:
   *  - `block=true`: the gateway should block this tool call and feed blockReason back to the main LLM.
   *  - Non-empty `params`: the gateway continues the call with corrected parameters (safety-related rewrites only).
   *  - Other cases: pass with original parameters.
   */
  async review(
    tool: string,
    params: Record<string, unknown>,
    sessionId: string,
  ): Promise<{ block: boolean; blockReason?: string; params?: Record<string, unknown> }> {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      return { block: false };
    }

    // ── Stage 1: Local synchronous quick check ─────────────────────
    const quickResult = this.quickChecker.checkToolCall(tool, params);

    if (quickResult.blocked) {
      this.logger.warn(`[ToolReviewer] Tool ${tool} blocked by quick check: ${quickResult.blockReason}`);
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'block',
        details: `Tool ${tool} blocked: ${quickResult.blockReason}`,
        timestamp: Date.now(),
      });
      return { block: true, blockReason: quickResult.blockReason };
    }

    // Non-high-risk tools: QuickChecker already checked and passed, no deep review needed.
    const isHighRisk = this.config.highRiskTools.includes(tool);

    if (!isHighRisk) {
      return { block: false };
    }

    // ── Stage 2: Reviewer deep review for high-risk tools ──────────
    const userContent = `## Tool Call\nTool: ${tool}\nParameters: ${JSON.stringify(params, null, 2)}`;
    const result = await this.reviewerClient.review<ToolReviewResult>(
      TOOL_REVIEW_SYSTEM_PROMPT,
      userContent,
    );

    // Failure policy: reviewer unavailable = pass. Review pipeline failures should not block legitimate calls.
    if (!result) {
      this.logger.warn(`Tool reviewer unavailable for ${tool}, passing through`);
      return { block: false };
    }

    if (result.blocked) {
      this.logger.warn(`[ToolReviewer] Tool ${tool} blocked by deep review: ${result.blockReason}`);
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'block',
        details: `Tool ${tool} blocked: ${result.blockReason ?? 'Deep review block'}`,
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });
      return { block: true, blockReason: result.blockReason };
    }

    // correctedParams: reviewer returned a "safer" parameter version (safety-only rewrites).
    if (result.correctedParams) {
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'correct',
        details: `Tool ${tool} parameters corrected`,
        metadata: JSON.stringify(result),
        timestamp: Date.now(),
      });
      return { block: false, params: result.correctedParams };
    }

    // Only warnings: pass but record to audit log for later review.
    if (result.warnings.length > 0) {
      this.auditLog.record({
        sessionId,
        type: 'tool_review',
        action: 'warn',
        details: `Tool ${tool} warnings: ${result.warnings.join('; ')}`,
        timestamp: Date.now(),
      });
    }

    return { block: false };
  }
}
