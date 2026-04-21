/**
 * Turn Context — per-turn state isolation via AsyncLocalStorage + registry fallback.
 *
 * Each user message creates a fresh `TurnState` that lives for the duration of
 * the message's processing pipeline (`before_prompt_build` → `message_sending`).
 * Hook handlers pick up the correct turn via:
 *   1. `turnStore.getStore()` — AsyncLocalStorage propagates along the async
 *      chain started in `before_prompt_build`. Concurrent turns A and B each have
 *      their own async chain and never see each other's store.
 *   2. `TurnRegistry.resolve(...)` — fallback when ALS context is lost (e.g. if
 *      the gateway dispatches a hook through an EventEmitter that breaks async
 *      context propagation). Uses phase + fingerprint heuristics.
 *
 * Callers should prefer `resolveTurn(registry, sessionId, phase, fingerprint)`
 * which combines both strategies.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { PluginLogger, TurnPhase, TurnState } from './types.js';

/** AsyncLocalStorage propagates the current TurnState through awaited hooks. */
export const turnStore = new AsyncLocalStorage<TurnState>();

/**
 * Build a fresh TurnState with defaulted fields. All fields reset per turn
 * — no inheritance from prior turns. `turnSeq` is assigned by the registry.
 */
function createEmptyTurn(sessionId: string, turnSeq: number, userMessage: string): TurnState {
  return {
    sessionId,
    turnSeq,
    turnId: `${sessionId}:${turnSeq}`,
    phase: 'received',
    createdAt: Date.now(),
    userMessage,

    stagedAnchorUpdates: {},
    regenerateHistory: [],
  };
}

/**
 * Per-session registry of active turns. Used as a fallback when ALS context
 * is unavailable, and as the source of truth for RPC (`listActive`).
 */
export class TurnRegistry {
  /** Per-session list of turns not yet in `phase === 'sent'`, ordered by turnSeq ascending. */
  private active = new Map<string, TurnState[]>();

  /** Per-session counter for monotonic turnSeq. */
  private counters = new Map<string, number>();

  /**
   * Register a brand-new TurnState and return it. Called from `before_prompt_build` (or `llm_input` fallback).
   */
  create(sessionId: string, userMessage: string): TurnState {
    const prev = this.counters.get(sessionId) ?? 0;
    const turnSeq = prev + 1;
    this.counters.set(sessionId, turnSeq);

    const turn = createEmptyTurn(sessionId, turnSeq, userMessage);

    const list = this.active.get(sessionId) ?? [];
    list.push(turn);
    this.active.set(sessionId, list);

    return turn;
  }

  /**
   * Advance a turn's lifecycle phase. Idempotent: repeated calls to the same
   * phase are no-ops, going backwards is also a no-op (logs nothing — callers
   * shouldn't need to check).
   */
  advancePhase(turn: TurnState, phase: TurnPhase): void {
    const order: TurnPhase[] = ['received', 'llm_input', 'llm_output', 'sending', 'sent'];
    if (order.indexOf(phase) > order.indexOf(turn.phase)) {
      turn.phase = phase;
    }
  }

  /**
   * Mark a turn as finished and remove it from the active list.
   * Callers should do this in `message_sending` (or on pipeline abort).
   */
  finish(turn: TurnState): void {
    if (turn.phase !== 'sent') {
      turn.phase = 'sent';
    }
    const list = this.active.get(turn.sessionId);
    if (!list) return;
    const idx = list.indexOf(turn);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.active.delete(turn.sessionId);
    else this.active.set(turn.sessionId, list);
  }

  /** Read-only snapshot of active turns for a session (used by RPC). */
  listActive(sessionId: string): TurnState[] {
    return [...(this.active.get(sessionId) ?? [])];
  }

  /** List session IDs that currently have at least one active turn. */
  listSessions(): string[] {
    return [...this.active.keys()];
  }

  /** Drop all active turns for a session (called on `session_end`). */
  dropSession(sessionId: string): void {
    this.active.delete(sessionId);
    this.counters.delete(sessionId);
  }

  /**
   * Fallback resolution when ALS store is empty. Selects the active turn that
   * is most likely to own the hook invocation based on phase + optional
   * fingerprint (user message text or response text).
   *
   * Matching rules (highest priority first):
   *  1. Exact `userMessage` fingerprint match, and turn phase still needs to
   *     advance to (or past) `requiredPhase`.
   *  2. First active turn whose phase is strictly less than `requiredPhase`
   *     (i.e. it could advance there next). FIFO by turnSeq.
   *  3. First active turn, as a last resort.
   */
  resolve(
    sessionId: string,
    requiredPhase: TurnPhase,
    fingerprint: { userMessage?: string } = {},
  ): TurnState | undefined {
    const list = this.active.get(sessionId);
    if (!list || list.length === 0) return undefined;

    const order: TurnPhase[] = ['received', 'llm_input', 'llm_output', 'sending', 'sent'];
    const requiredIdx = order.indexOf(requiredPhase);

    if (fingerprint.userMessage) {
      const hit = list.find(
        (t) => t.userMessage === fingerprint.userMessage && order.indexOf(t.phase) < requiredIdx,
      );
      if (hit) return hit;
    }

    const byPhase = list.find((t) => order.indexOf(t.phase) < requiredIdx);
    if (byPhase) return byPhase;

    return list[0];
  }
}

/**
 * Resolve the current TurnState for a hook, preferring ALS store and falling
 * back to the registry. Returns `undefined` only if both fail (pipeline ran
 * outside of any known turn).
 */
export function resolveTurn(
  registry: TurnRegistry,
  sessionId: string | undefined,
  requiredPhase: TurnPhase,
  fingerprint: { userMessage?: string } = {},
  logger?: PluginLogger,
): TurnState | undefined {
  const fromStore = turnStore.getStore();
  if (fromStore) return fromStore;

  if (!sessionId) return undefined;

  const fallback = registry.resolve(sessionId, requiredPhase, fingerprint);
  if (fallback && logger) {
    logger.warn(
      `[TurnContext] ALS store empty, fallback resolved turn ${fallback.turnId} (phase=${fallback.phase}, requiredPhase=${requiredPhase})`,
    );
  }
  return fallback;
}

/**
 * Extract the last user message text from an `llm_input` messages array, used
 * as fingerprint for fallback resolution.
 */
export function extractLastUserMessageText(
  messages: Array<{ role: string; content: unknown }>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const parts: string[] = [];
        for (const block of msg.content) {
          if (block && typeof block === 'object' && 'text' in block) {
            const t = (block as { text?: unknown }).text;
            if (typeof t === 'string') parts.push(t);
          }
        }
        if (parts.length > 0) return parts.join('');
      }
    }
  }
  return undefined;
}
