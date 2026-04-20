/**
 * Tests for the per-turn isolation layer:
 *   - TurnRegistry lifecycle (create/advance/finish/listActive/dropSession)
 *   - AsyncLocalStorage propagation via `turnStore.run`
 *   - Fallback resolution via `resolveTurn`
 *   - Stale-turn guard semantics (phase === 'sent')
 */

import { describe, expect, it } from 'vitest';
import {
  TurnRegistry,
  turnStore,
  resolveTurn,
  extractLastUserMessageText,
} from '../core/turn-context.js';

describe('TurnRegistry', () => {
  it('creates turns with monotonic turnSeq per session', () => {
    const r = new TurnRegistry();
    const t1 = r.create('s1', 'msg1');
    const t2 = r.create('s1', 'msg2');
    const t3 = r.create('s2', 'msg3');

    expect(t1.turnSeq).toBe(1);
    expect(t1.turnId).toBe('s1:1');
    expect(t2.turnSeq).toBe(2);
    expect(t2.turnId).toBe('s1:2');
    expect(t3.turnSeq).toBe(1);
    expect(t3.turnId).toBe('s2:1');
  });

  it('starts each turn at phase=received with default per-turn fields', () => {
    const r = new TurnRegistry();
    const t = r.create('s1', 'hello');

    expect(t.phase).toBe('received');
    expect(t.sessionId).toBe('s1');
    expect(t.userMessage).toBe('hello');
    expect(t.stagedAnchorUpdates).toEqual({});
    expect(t.regenerateHistory).toEqual([]);
  });

  it('advancePhase only moves forward', () => {
    const r = new TurnRegistry();
    const t = r.create('s', 'x');

    r.advancePhase(t, 'llm_input');
    expect(t.phase).toBe('llm_input');

    r.advancePhase(t, 'received');
    expect(t.phase).toBe('llm_input');

    r.advancePhase(t, 'llm_output');
    r.advancePhase(t, 'sending');
    expect(t.phase).toBe('sending');
  });

  it('finish sets phase=sent and removes from active list', () => {
    const r = new TurnRegistry();
    const t1 = r.create('s', 'a');
    const t2 = r.create('s', 'b');
    expect(r.listActive('s')).toHaveLength(2);

    r.finish(t1);
    expect(t1.phase).toBe('sent');
    expect(r.listActive('s').map((t) => t.turnId)).toEqual([t2.turnId]);
  });

  it('dropSession clears active turns and resets turnSeq counter', () => {
    const r = new TurnRegistry();
    r.create('s', 'a');
    r.create('s', 'b');

    r.dropSession('s');
    expect(r.listActive('s')).toEqual([]);
    expect(r.listSessions()).toEqual([]);

    const fresh = r.create('s', 'c');
    expect(fresh.turnSeq).toBe(1);
  });
});

describe('turnStore (AsyncLocalStorage propagation)', () => {
  it('propagates the turn through async chain', async () => {
    const r = new TurnRegistry();
    const t = r.create('s1', 'm1');

    const result = await turnStore.run(t, async () => {
      await Promise.resolve();
      const viaStore = turnStore.getStore();
      await Promise.resolve();
      return viaStore;
    });

    expect(result).toBe(t);
  });

  it('keeps concurrent turns isolated (A and B do not see each other)', async () => {
    const r = new TurnRegistry();
    const tA = r.create('s', 'A');
    const tB = r.create('s', 'B');

    const [a, b] = await Promise.all([
      turnStore.run(tA, async () => {
        await new Promise((res) => setTimeout(res, 10));
        return turnStore.getStore()?.turnId;
      }),
      turnStore.run(tB, async () => {
        return turnStore.getStore()?.turnId;
      }),
    ]);

    expect(a).toBe(tA.turnId);
    expect(b).toBe(tB.turnId);
  });
});

describe('resolveTurn', () => {
  it('prefers ALS store when available', async () => {
    const r = new TurnRegistry();
    const inStore = r.create('s', 'in-store');
    r.create('s', 'another-active');

    const resolved = await turnStore.run(inStore, () =>
      resolveTurn(r, 'another-session', 'llm_output'),
    );
    expect(resolved).toBe(inStore);
  });

  it('falls back to registry by fingerprint match', () => {
    const r = new TurnRegistry();
    r.create('s', 'first');
    const second = r.create('s', 'second');
    r.advancePhase(second, 'llm_input');

    const resolved = resolveTurn(r, 's', 'llm_output', { userMessage: 'second' });
    expect(resolved).toBe(second);
  });

  it('falls back by phase when no fingerprint match', () => {
    const r = new TurnRegistry();
    const t1 = r.create('s', 'x');
    const t2 = r.create('s', 'y');
    r.advancePhase(t1, 'llm_output');

    // t1 is past llm_input already, t2 is still at received so it wins for
    // requiredPhase=llm_input (first that still needs to reach it).
    const resolved = resolveTurn(r, 's', 'llm_input');
    expect(resolved).toBe(t2);
  });

  it('returns undefined when registry empty and store empty', () => {
    const r = new TurnRegistry();
    expect(resolveTurn(r, 'nobody', 'llm_input')).toBeUndefined();
  });

  it('returns undefined when sessionId is missing and store empty', () => {
    const r = new TurnRegistry();
    r.create('s', 'x');
    expect(resolveTurn(r, undefined, 'llm_input')).toBeUndefined();
  });
});

describe('extractLastUserMessageText', () => {
  it('extracts plain string content from the last user message', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'older' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'latest user msg' },
    ];
    expect(extractLastUserMessageText(msgs)).toBe('latest user msg');
  });

  it('flattens OpenAI-style content blocks', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] },
    ];
    expect(extractLastUserMessageText(msgs)).toBe('hello world');
  });

  it('returns undefined when no user message present', () => {
    expect(extractLastUserMessageText([{ role: 'system', content: 's' }])).toBeUndefined();
  });
});

describe('stale-turn guard semantics', () => {
  it('finish() marks turn so async callbacks can detect "already sent"', async () => {
    const r = new TurnRegistry();
    const t = r.create('s', 'x');

    // Simulate an in-flight async callback captured in closure:
    const delayedWrite = (async () => {
      await new Promise((res) => setTimeout(res, 5));
      if (t.phase === 'sent') {
        return 'skipped';
      }
      t.stagedAnchorUpdates.researchGoal = 'late-write';
      return 'written';
    })();

    r.finish(t);
    const result = await delayedWrite;

    expect(result).toBe('skipped');
    expect(t.stagedAnchorUpdates.researchGoal).toBeUndefined();
  });
});
