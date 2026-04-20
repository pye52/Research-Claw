/**
 * Dual Model Supervisor — `message_sending` hook context probing utility
 *
 * Responsibilities
 *  - Converge the "shape-shifting-with-version" ctx that the OpenClaw gateway passes
 *    into the `message_sending` hook into a stable, loggable `MessageSendingCtxSnapshot`.
 *  - Provides two key determinations:
 *      1. `deferReview`: whether the current call is a streaming intermediate chunk
 *         (review should be skipped).
 *      2. `isChannelDelivery`: whether this message is being delivered via an external
 *         channel (Telegram / WeChat / Discord / …); used to decide whether to append
 *         the reviewer summary to the end of the message body (only channel messages get
 *         the footer; Dashboard messages are displayed separately via the Supervisor panel
 *         to avoid polluting the main conversation).
 *
 * Design rationale
 *  - The same gateway version may use different fields to express "is this the final chunk".
 *    Writing `if (ctx.partial && ...)` directly in the caller would fragment with versions;
 *    convergence is centralized here so the caller only sees a boolean.
 *  - `SUPERVISOR_REVIEW_SUMMARY_MARKER` is the stable marker string appended in the footer:
 *    when the reviewer re-reviews a message and finds it already contains this marker,
 *    it passes through directly, avoiding duplicate appends / infinite loops.
 *  - This module **must not** contain any business policy; it is only responsible for
 *    "understanding what the gateway gave us".
 */

/**
 * Stable substring that appears in appended footers, also serving as an idempotency skip marker.
 * Any review path that sees this marker already present in the message should pass through directly to avoid duplicate appends.
 */
export const SUPERVISOR_REVIEW_SUMMARY_MARKER = '🔍 **[Supervisor]**';

export type MessageSendingCtxSnapshot = {
  keys: string[];
  /** true when the context indicates this is a streaming / chunked fragment (not the final message); caller should skip review. */
  deferReview: boolean;
  /** true when this message is being delivered via an external channel (Telegram / WeChat / Discord, etc.). */
  isChannelDelivery: boolean;
  /** Snapshot of all flags from the raw ctx that may affect determination, for logging / debugging only. */
  flags: {
    streaming?: unknown;
    partial?: unknown;
    stream?: unknown;
    isFinal?: unknown;
    done?: unknown;
    complete?: unknown;
    phase?: unknown;
    channel?: unknown;
    deliveryMode?: unknown;
    source?: unknown;
  };
};

/**
 * Take a snapshot of the `message_sending` hook context and determine:
 *  - whether review should be deferred (streaming chunk);
 *  - whether delivery is via an external channel.
 *
 * Why "snapshot" instead of using ctx directly:
 *  - Gateway versions have inconsistent fields; callers need a stable structure with tolerant convergence;
 *  - We only want to review the final aggregated assistant message; chunk review is meaningless and would cause duplicate footer appends.
 */
export function snapshotMessageSendingCtx(ctx: unknown): MessageSendingCtxSnapshot {
  const keys = ctx && typeof ctx === 'object' ? Object.keys(ctx as object).sort() : [];
  const o = (ctx && typeof ctx === 'object' ? ctx : {}) as Record<string, unknown>;
  const flags = {
    streaming: o.streaming,
    partial: o.partial,
    stream: o.stream,
    isFinal: o.isFinal,
    done: o.done,
    complete: o.complete,
    phase: o.phase,
    channel: o.channel,
    deliveryMode: o.deliveryMode,
    source: o.source,
  };

  const isChannelDelivery = detectChannelDelivery(o);

  // Explicitly marked as final chunk: pass through for review (do not defer).
  if (o.isFinal === true || o.done === true || o.complete === true) {
    return { keys, deferReview: false, isChannelDelivery, flags };
  }

  // Note: do not rely solely on `stream` / `streaming` to determine "chunking".
  // Some gateways set streaming=true even on the **final** aggregated message (indicating transport mode only);
  // if used to defer, all outputs would be skipped and the footer would never be appended.
  // Therefore only accept more explicit signals: partial=true, isFinal/done/complete=false, or phase containing chunk keywords.
  const deferReview =
    o.partial === true ||
    o.isFinal === false ||
    o.done === false ||
    o.complete === false ||
    (typeof o.phase === 'string' && /delta|streaming|partial|chunk/i.test(o.phase));

  return { keys, deferReview, isChannelDelivery, flags };
}

/**
 * Determine whether this `message_sending` corresponds to "delivery to an external channel".
 *
 * When the gateway routes the message to an external channel plugin (Telegram / WeChat / Discord / Feishu / Slack / iMessage, etc.),
 * it attaches channel / deliveryMode / source / delivery fields; Dashboard sends do not have them.
 * Only in external channel scenarios does OutputReviewer append the review summary to the end of the message body — Dashboard users
 * see review results through the Supervisor panel, so the footer does not need to be inserted into the conversation flow.
 */
function detectChannelDelivery(ctx: Record<string, unknown>): boolean {
  // 1. Explicit top-level channel string (most common signal).
  if (typeof ctx.channel === 'string' && ctx.channel.length > 0) return true;
  // 2. deliveryMode is direct/announce, indicating proactive outbound delivery.
  if (ctx.deliveryMode === 'direct' || ctx.deliveryMode === 'announce') return true;
  // 3. source field starts with a known channel prefix (message backflow scenario).
  if (typeof ctx.source === 'string' && /^(telegram|discord|weixin|wechat|feishu|slack|imessage)/i.test(ctx.source)) return true;
  // 4. Fallback: some newer versions nest channel info under ctx.delivery.
  const delivery = ctx.delivery as Record<string, unknown> | undefined;
  if (delivery && typeof delivery === 'object') {
    if (typeof delivery.channel === 'string' && delivery.channel.length > 0) return true;
    if (delivery.mode === 'direct' || delivery.mode === 'announce') return true;
  }
  return false;
}
