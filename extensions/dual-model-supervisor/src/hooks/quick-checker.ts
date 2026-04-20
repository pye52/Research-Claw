/**
 * Dual Model Supervisor — QuickChecker (synchronous local rules as the "first gate")
 *
 * Responsibilities
 *  - Before invoking the reviewer model, use pure regex to intercept the most obvious
 *    high-risk / privacy / fabricated content within milliseconds; and at the tool call
 *    level block fatal `exec` commands and system path writes.
 *  - Always synchronous: no network calls, no LLM dependency.
 *
 * Design rationale
 *  - Remote reviewer calls are slow, have non-zero failure rates, and cost tokens; issues
 *    like `rm -rf /` should never wait in line for an LLM to be intercepted — local rules
 *    provide the most stable one-shot veto.
 *  - Rules are "high-precision, low-recall": better to miss ambiguous samples (leave them
 *    for the reviewer deep inspection) than to falsely flag normal output. Therefore only
 *    **strong patterns with near-zero false positives** are listed here.
 *  - Relationship with PreReviewFilter / OutputReviewer / ToolReviewer: this class only
 *    provides capabilities, does not subscribe to hooks; the upper layer decides when to
 *    call and how to handle the results.
 */

import type { SupervisorConfig, PluginLogger } from '../core/types.js';

/** Dangerous command patterns that trigger immediate block (rm -rf /, format c:, dd if=, fork bomb). */
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\//i,
  /\bformat\s+[a-z]:/i,
  /\bdd\s+if=/i,
  /\b:\(\)\{\s*:\|\:&\s*\}/,  // Fork bomb
];

/** Plaintext credential leakage patterns that trigger immediate block (password=, api_key=, etc. with long strings). */
const PRIVACY_PATTERNS = [
  /\b(?:password|passwd|secret|token)\s*[=:]\s*['"][^'"]{8,}/i,
  /\b(?:api[_-]?key|access[_-]?key)\s*[=:]\s*['"][^'"]{8,}/i,
];

/** "Suspicious fabricated citation" patterns that only produce warnings — high false-positive rate, do not block. */
const FABRICATED_CITATION_PATTERNS = [
  /\bdoi:\s*10\.\d{4}\/[a-z0-9.-]+\/?\s*\([^)]*\d{4}[^)]*\)/i,
];

export interface QuickCheckResult {
  blocked: boolean;
  blockReason?: string;
  warnings: string[];
}

export class QuickChecker {
  private config: SupervisorConfig;
  private logger: PluginLogger;

  constructor(config: SupervisorConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
  }

  updateConfig(config: SupervisorConfig): void {
    this.config = config;
  }

  /**
   * Check a piece of message text (usually LLM output).
   *  - Matches DANGEROUS_PATTERNS / PRIVACY_PATTERNS: directly set `blocked=true`.
   *  - Matches FABRICATED_CITATION_PATTERNS: only append warning, do not block.
   *
   * When supervision is disabled or reviewMode=off, pass directly — QuickChecker also respects the master switch.
   */
  check(content: string): QuickCheckResult {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      return { blocked: false, warnings: [] };
    }

    const warnings: string[] = [];
    let blocked = false;
    let blockReason: string | undefined;

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(content)) {
        blocked = true;
        blockReason = 'Output contains potentially dangerous command patterns';
        this.logger.warn(`[QuickChecker] Blocked: dangerous pattern matched`);
        break;
      }
    }

    for (const pattern of PRIVACY_PATTERNS) {
      if (pattern.test(content)) {
        blocked = true;
        blockReason = 'Output may contain sensitive credentials or personal information';
        this.logger.warn(`[QuickChecker] Blocked: privacy leakage pattern matched`);
        break;
      }
    }

    for (const pattern of FABRICATED_CITATION_PATTERNS) {
      if (pattern.test(content)) {
        warnings.push('Output may contain fabricated citation patterns');
        break;
      }
    }

    return { blocked, blockReason, warnings };
  }

  /**
   * Synchronous quick check version for tool calls.
   *
   * Only performs fine-grained checks on tools listed in `config.highRiskTools`:
   *  - `exec`: checks command/cmd parameters with DANGEROUS_PATTERNS, blocks on match.
   *  - `write` / `edit`: prohibits writing to system paths like `/etc/` or `/System/`.
   *  - Other high-risk tools: pass with warning, leaving deeper assessment to ToolReviewer's deep review.
   *
   * Non-highRisk tools pass directly (no warning) to avoid noise.
   */
  checkToolCall(tool: string, params: Record<string, unknown>): QuickCheckResult {
    if (!this.config.enabled || this.config.reviewMode === 'off') {
      return { blocked: false, warnings: [] };
    }

    const isHighRisk = this.config.highRiskTools.includes(tool);
    if (!isHighRisk) {
      return { blocked: false, warnings: [] };
    }

    if (tool === 'exec') {
      // Supports both common parameter names: command / cmd.
      const command = String(params.command ?? params.cmd ?? '');
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          this.logger.warn(`[QuickChecker] Blocked exec: dangerous command pattern`);
          return {
            blocked: true,
            blockReason: 'Dangerous command detected in exec call',
            warnings: [],
          };
        }
      }
    }

    if (tool === 'write' || tool === 'edit') {
      // Both path and file are treated as the target file path.
      const filePath = String(params.path ?? params.file ?? '');
      if (filePath.includes('/etc/') || filePath.includes('/System/')) {
        this.logger.warn(`[QuickChecker] Blocked write to system path: ${filePath}`);
        return {
          blocked: true,
          blockReason: `Attempt to write to system directory: ${filePath}`,
          warnings: [],
        };
      }
    }

    // High-risk but did not trigger hard rules: leave a warning and let the upper layer decide whether to deep review.
    return { blocked: false, warnings: [`High-risk tool call: ${tool}`] };
  }
}
