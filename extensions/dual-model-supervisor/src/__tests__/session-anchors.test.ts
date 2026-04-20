/**
 * SessionAnchorsRegistry — merge goal ladder, dedup append, blocks queue.
 */

import { describe, expect, it } from 'vitest';
import {
  SessionAnchorsRegistry,
  mergeGoal,
  dedupAppend,
} from '../core/session-anchors.js';
import type { SessionAnchors } from '../core/session-anchors.js';

function empty(): SessionAnchors {
  return {
    goalConfirmed: false,
    targetConclusions: [],
    keyConclusions: [],
    userPreferences: [],
    methodologyDecisions: [],
    recentSummaries: [],
    recentReviewReports: [],
    pendingPrependBlocks: [],
  };
}

describe('mergeGoal', () => {
  it('first write accepts any incoming including unconfirmed', () => {
    const a = empty();
    mergeGoal(a, 'g1', false, undefined);
    expect(a.researchGoal).toBe('g1');
    expect(a.goalConfirmed).toBe(false);
  });

  it('false→true upgrade replaces without similarity', () => {
    const a = empty();
    a.researchGoal = 'fallback';
    a.goalConfirmed = false;
    mergeGoal(a, 'confirmed goal', true, undefined);
    expect(a.researchGoal).toBe('confirmed goal');
    expect(a.goalConfirmed).toBe(true);
  });

  it('true→false keeps current', () => {
    const a = empty();
    a.researchGoal = 'stable';
    a.goalConfirmed = true;
    mergeGoal(a, 'noise', false, undefined);
    expect(a.researchGoal).toBe('stable');
    expect(a.goalConfirmed).toBe(true);
  });

  it('true→true + hint keep preserves', () => {
    const a = empty();
    a.researchGoal = 'stable';
    a.goalConfirmed = true;
    mergeGoal(a, 'other', true, 'keep');
    expect(a.researchGoal).toBe('stable');
  });

  it('true→true + hint replace updates', () => {
    const a = empty();
    a.researchGoal = 'stable';
    a.goalConfirmed = true;
    mergeGoal(a, 'pivot', true, 'replace');
    expect(a.researchGoal).toBe('pivot');
    expect(a.goalConfirmed).toBe(true);
  });

  it('true→true + unknown (or no hint) defaults to keep', () => {
    const a = empty();
    a.researchGoal = 'machine learning for NLP';
    a.goalConfirmed = true;
    mergeGoal(a, 'deep learning for NLP tasks', true, 'unknown');
    expect(a.researchGoal).toBe('machine learning for NLP');

    // 无 hint 时同样 keep
    mergeGoal(a, 'totally different research goal', true, 'unknown');
    expect(a.researchGoal).toBe('machine learning for NLP');
  });
});

describe('dedupAppend', () => {
  it('dedups case-insensitively and caps', () => {
    const arr: string[] = [];
    dedupAppend(arr, 'A', 3);
    dedupAppend(arr, 'a', 3);
    dedupAppend(arr, 'b', 3);
    dedupAppend(arr, 'c', 3);
    dedupAppend(arr, 'd', 3);
    expect(arr.length).toBeLessThanOrEqual(3);
  });
});

describe('SessionAnchorsRegistry', () => {
  it('drainBlocks clears queue FIFO', () => {
    const r = new SessionAnchorsRegistry();
    r.enqueueBlock('s1', { type: 'driftCorrection', text: 'a' });
    r.enqueueBlock('s1', { type: 'driftCorrection', text: 'b' });
    const d = r.drainBlocks('s1');
    expect(d).toHaveLength(2);
    expect(d[0]?.type).toBe('driftCorrection');
    expect(r.drainBlocks('s1')).toEqual([]);
  });

  it('merge strips _goalReplaceHint from persistence path', () => {
    const r = new SessionAnchorsRegistry();
    r.merge(
      's1',
      {
        researchGoal: 'g',
        goalConfirmed: true,
        _goalReplaceHint: 'replace',
      },
    );
    const v = r.view('s1');
    expect(v.researchGoal).toBe('g');
    expect((v as { _goalReplaceHint?: unknown })._goalReplaceHint).toBeUndefined();
  });
});
