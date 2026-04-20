/**
 * Dual Model Supervisor — PreReviewFilter (Layer 1 of tiered review: local synchronous pre-filter)
 *
 * Responsibilities
 *  - In the `message_received` hook, immediately identify "obviously non-research messages" —
 *    greetings, thanks, brief emotional feedback, pure emoji — and directly issue a `skip` decision.
 *  - The entire process involves zero network calls, zero token consumption, and returns within milliseconds.
 *
 * Position in the tiered architecture
 *    Layer 1  This class (local regex / phrase set)            ─── synchronous / 0 token
 *    Layer 2  Gatekeeper (one small reviewer call to decide whether to proceed with full flow)
 *    Layer 3  GoalParser / OutputReviewer / … full deep review
 *  This layer is only responsible for "directly skipping obvious nonsense"; ambiguous samples always return pass,
 *  to be adjudicated by the subsequent two layers.
 *
 * Design rationale
 *  - The complete reviewer pipeline (goal-parser, consistency-check, output-review,
 *    summary-extract, etc.) may trigger 4~6 reviewer calls per user turn; for messages
 *    like "嗯" / "收到" / "thanks" this is both wasteful and likely to pollute anchors.
 *  - **Exact full-text match** rather than includes: avoids misclassifying "你好分析一下" as a greeting;
 *    only skips when `trimmed.length < minContentLength` and the lower-case text exactly falls within the phrase set.
 *  - Decision results are passed downstream to other hooks via `sessionState.trivialTurn` (goal-parser etc.
 *    will skip anchor writes), forming an end-to-end "lightweight turn".
 */

import type { PreReviewFilterConfig, PluginLogger } from '../core/types.js';

// ── Built-in phrase set for "obviously non-research" messages ───────────────────────────────────────
// Only used for **exact** match after trim+lowercase —— for example, "你好分析一下" won't be falsely killed.
// When adding or removing entries, only include greetings / acknowledgments / pleasantries that carry no research information on their own.

const TRIVIAL_PHRASES = new Set([
  // Chinese greetings
  '你好', '您好', '嗨', '哈喽', '嘿',
  // Chinese acknowledgments
  '好的', '明白', '了解', '知道了', '收到', '懂了', '嗯', '哦',
  // Chinese thanks
  '谢谢', '感谢', '多谢', '谢了',
  // Chinese farewells
  '再见', '拜拜', '下次见',
  // English greetings
  'hello', 'hi', 'hey', 'hiya',
  // English acknowledgments
  'ok', 'okay', 'got it', 'understood', 'sure', 'right', 'yeah', 'yes', 'yep', 'nope',
  // English thanks
  'thanks', 'thank you', 'thx', 'ty',
  // English farewells
  'bye', 'goodbye', 'see you',
]);

// Messages consisting entirely of emoji / emoticons (including modifiers, components) + whitespace:
// Also treated as non-research messages and directly skipped.
const EMOJI_ONLY_RE = /^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Component}\s]+$/u;

export interface PreReviewFilterResult {
  decision: 'skip' | 'pass';
  reason: string;
}

export class PreReviewFilter {
  private config: PreReviewFilterConfig;
  private logger: PluginLogger;

  constructor(config: PreReviewFilterConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
  }

  updateConfig(config: PreReviewFilterConfig): void {
    this.config = config;
  }

  /**
   * Synchronously decide whether a user input is worth running through the full review pipeline.
   *
   * Returns:
   *  - `skip`: all reviewer calls in this turn should be skipped (goal-parser / consistency / output-review …).
   *  - `pass`: no obvious nonsense rules matched; pass the decision to Gatekeeper or subsequent full review.
   *
   * False-positive cost far exceeds false-negative: better to pass a short message and let Gatekeeper run once more,
   * than to ignore "analyze this data" as a pleasantry.
   */
  shouldReview(content: string): PreReviewFilterResult {
    const trimmed = content.trim();

    // 1. Completely blank: skip (nothing to review).
    if (trimmed.length === 0) {
      return { decision: 'skip', reason: 'empty message' };
    }

    // 2. Only skip when the message is **both short** **and** exactly matches a known phrase / is all emoji.
    //    Length threshold is controlled by configuration to avoid inadvertently swallowing longer messages like "嗯，那我们继续做...".
    if (trimmed.length < this.config.minContentLength) {
      const lower = trimmed.toLowerCase();
      if (TRIVIAL_PHRASES.has(lower)) {
        this.logger.info(`[PreReviewFilter] Skip: trivial phrase "${trimmed}"`);
        return { decision: 'skip', reason: `trivial phrase: "${trimmed}"` };
      }

      if (EMOJI_ONLY_RE.test(trimmed)) {
        this.logger.info(`[PreReviewFilter] Skip: emoji-only message`);
        return { decision: 'skip', reason: 'emoji-only message' };
      }
    }

    // Any content that cannot be instantly judged as nonsense goes to the next layer (Gatekeeper / full review).
    this.logger.info(`[PreReviewFilter] Pass: content length=${trimmed.length}, not trivial`);
    return { decision: 'pass', reason: 'content passed local pre-check' };
  }
}
