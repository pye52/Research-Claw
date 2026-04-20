/**
 * Concurrent-turn isolation tests — simulate user sending message A then B in
 * quick succession, with B's async processing racing A's.
 * with per-turn TurnState the two turns must stay fully isolated.
 */

import { describe, expect, it } from 'vitest';
import {
  TurnRegistry,
  turnStore,
  resolveTurn,
} from '../core/turn-context.js';
import type { TurnState } from '../core/types.js';

/**
 * Minimal stand-in for the three hook phases that mutate TurnState:
 *   message_received → goalParser writes researchGoal
 *   llm_output       → summaryExtractor + courseCorrector (staged anchors + enqueue blocks)
 *   message_sending  → consumes + finishes turn
 *
 * Each simulated hook binds to a specific turn via closure, mirroring how the
 * real hook handlers work after the refactor.
 */

async function runTurnPipeline(
  registry: TurnRegistry,
  turn: TurnState,
  opts: { parseDelayMs: number; reviewDelayMs: number; parsedGoal: string },
): Promise<string | undefined> {
  return turnStore.run(turn, async () => {
    // --- message_received: schedule async goal parse ---
    const goalParse = (async () => {
      await new Promise((res) => setTimeout(res, opts.parseDelayMs));
      if (turn.phase === 'sent') return;
      turn.stagedAnchorUpdates.researchGoal = opts.parsedGoal;
      turn.stagedAnchorUpdates.goalConfirmed = true;
    })();

    // --- llm_input (synchronous step, advance phase) ---
    registry.advancePhase(turn, 'llm_input');

    // --- llm_output: schedule async output review ---
    const outputReview = (async () => {
      await new Promise((res) => setTimeout(res, opts.reviewDelayMs));
      if (turn.phase === 'sent') return;
      turn.pendingChannelReviewFooter = `footer-for-${turn.turnId}`;
      turn.turnLlmOutput = `output-for-${turn.turnId}`;
    })();
    registry.advancePhase(turn, 'llm_output');

    await Promise.all([goalParse, outputReview]);

    // --- message_sending: consume footer, finish turn ---
    registry.advancePhase(turn, 'sending');
    const footer = turn.pendingChannelReviewFooter;
    turn.pendingChannelReviewFooter = undefined;
    registry.finish(turn);
    return footer;
  });
}

describe('concurrent turns — B runs first but does not contaminate A', () => {
  it('each turn sees its own researchGoal and footer', async () => {
    const registry = new TurnRegistry();

    const turnA = registry.create('session-1', 'What is RLHF?');
    const turnB = registry.create('session-1', 'Give me code');

    expect(registry.listActive('session-1')).toHaveLength(2);

    // B completes faster than A.
    const [footerA, footerB] = await Promise.all([
      runTurnPipeline(registry, turnA, {
        parseDelayMs: 30,
        reviewDelayMs: 40,
        parsedGoal: 'Explain RLHF',
      }),
      runTurnPipeline(registry, turnB, {
        parseDelayMs: 5,
        reviewDelayMs: 10,
        parsedGoal: 'Produce code',
      }),
    ]);

    expect(turnA.stagedAnchorUpdates.researchGoal).toBe('Explain RLHF');
    expect(turnA.turnLlmOutput).toBe(`output-for-${turnA.turnId}`);
    expect(footerA).toBe(`footer-for-${turnA.turnId}`);

    expect(turnB.stagedAnchorUpdates.researchGoal).toBe('Produce code');
    expect(turnB.turnLlmOutput).toBe(`output-for-${turnB.turnId}`);
    expect(footerB).toBe(`footer-for-${turnB.turnId}`);

    expect(registry.listActive('session-1')).toEqual([]);
    expect(turnA.phase).toBe('sent');
    expect(turnB.phase).toBe('sent');
  });

  it('late async writes after finish() do not mutate the turn (stale guard)', async () => {
    const registry = new TurnRegistry();
    const turn = registry.create('s', 'late-msg');

    const latePromise = turnStore.run(turn, async () => {
      await new Promise((res) => setTimeout(res, 50));
      if (turn.phase === 'sent') return 'guarded';
      turn.stagedAnchorUpdates.researchGoal = 'SHOULD NOT APPEAR';
      return 'wrote';
    });

    // Simulate the rest of the pipeline completing quickly.
    registry.advancePhase(turn, 'llm_input');
    registry.advancePhase(turn, 'llm_output');
    registry.advancePhase(turn, 'sending');
    registry.finish(turn);

    const outcome = await latePromise;
    expect(outcome).toBe('guarded');
    expect(turn.stagedAnchorUpdates.researchGoal).toBeUndefined();
  });

  it('fallback resolve picks the in-flight turn when ALS is empty', () => {
    const registry = new TurnRegistry();
    const turnA = registry.create('s', 'A');
    const turnB = registry.create('s', 'B');
    registry.advancePhase(turnA, 'llm_output');

    // Simulate a hook that arrived outside ALS context (store empty) and
    // needs to advance to llm_input. turnA is already past that phase, so
    // turnB is the natural candidate.
    const resolved = resolveTurn(registry, 's', 'llm_input');
    expect(resolved).toBe(turnB);
  });

  it('session_end drops all active turns for the session', () => {
    const registry = new TurnRegistry();
    registry.create('s', 'A');
    registry.create('s', 'B');
    registry.create('other', 'X');

    registry.dropSession('s');
    expect(registry.listActive('s')).toEqual([]);
    expect(registry.listActive('other')).toHaveLength(1);
  });
});
