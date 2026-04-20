/**
 * CompactionEventRegistry — one active event per session, independent of TurnState.
 */

import { describe, expect, it } from 'vitest';
import { CompactionEventRegistry } from '../core/compaction-event.js';

describe('CompactionEventRegistry', () => {
  it('begin creates event with empty preCompactionMemory', () => {
    const r = new CompactionEventRegistry();
    const ev = r.begin('s1');
    expect(ev.sessionId).toBe('s1');
    expect(ev.preCompactionMemory).toEqual([]);
    expect(ev.createdAt).toBeGreaterThan(0);
  });

  it('current returns active event', () => {
    const r = new CompactionEventRegistry();
    const ev = r.begin('s1');
    ev.preCompactionMemory = [{ category: 'research_goal', summary: 'goal' }];
    expect(r.current('s1')).toBe(ev);
  });

  it('end removes event', () => {
    const r = new CompactionEventRegistry();
    r.begin('s1');
    r.end('s1');
    expect(r.current('s1')).toBeUndefined();
  });

  it('dropAll clears session', () => {
    const r = new CompactionEventRegistry();
    r.begin('s1');
    r.dropAll('s1');
    expect(r.current('s1')).toBeUndefined();
  });

  it('sessions can have independent events', () => {
    const r = new CompactionEventRegistry();
    const a = r.begin('a');
    const b = r.begin('b');
    expect(r.current('a')).toBe(a);
    expect(r.current('b')).toBe(b);
    r.end('a');
    expect(r.current('a')).toBeUndefined();
    expect(r.current('b')).toBe(b);
  });
});
