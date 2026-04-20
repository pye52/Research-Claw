/**
 * Session anchors — per-session monotonic / append-only state + FIFO prepend queue.
 */

import type { MessageSummary } from './types.js';

/** Jaccard threshold for methodology replacement — replace when similarity drops below this. */
export const METHODOLOGY_REPLACE_THRESHOLD = 0.6;

/** Caps for append-only fields (YAGNI: not exposed to RPC yet). */
export const ANCHOR_CAPS = {
  target: 15,
  conclusions: 20,
  preferences: 20,
  methodologyDecisions: 20,
  summaries: 10,
  reviewReports: 5,
} as const;

export type PendingBlock =
  | { type: 'lostMemory'; text: string }
  | {
      type: 'forceRegenerate';
      deviationScore: number;
      correctionInstruction: string;
      originalOutputPreview: string;
    }
  | { type: 'driftCorrection'; text: string }
  | { type: 'consistencyCorrection'; text: string }
  | { type: 'previousReview'; text: string };

export type GoalReplaceHint = 'replace' | 'keep' | 'unknown';

export interface SessionAnchors {
  researchGoal?: string;
  goalConfirmed: boolean;
  methodology?: string;
  targetConclusions: string[];
  keyConclusions: string[];
  userPreferences: string[];
  methodologyDecisions: string[];
  recentSummaries: MessageSummary[];
  recentReviewReports: string[];
  pendingPrependBlocks: PendingBlock[];
}

/** Patch from a turn before merge; `_goalReplaceHint` is stripped and never persisted. */
export type StagedAnchorPatch = Partial<SessionAnchors> & {
  _goalReplaceHint?: GoalReplaceHint;
};

function emptyAnchors(): SessionAnchors {
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

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

/** Jaccard similarity in [0, 1]. */
export function jaccardSimilarity(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) {
    if (B.has(t)) inter += 1;
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Replace monotonic text when similarity is BELOW threshold (more different → replace).
 * threshold 0.6 means: replace when Jaccard < 0.6 (topics diverged).
 */
export function shouldReplaceMonotonic(current: string, incoming: string, threshold: number): boolean {
  return jaccardSimilarity(current, incoming) < threshold;
}

function normKey(s: string): string {
  return s.trim().toLowerCase();
}

export function dedupAppend(arr: string[], item: string, cap: number): void {
  const n = normKey(item);
  if (!n) return;
  if (arr.some((x) => normKey(x) === n)) return;
  arr.push(item.trim());
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

export function mergeGoal(
  current: SessionAnchors,
  incomingGoal: string | undefined,
  incomingConfirmed: boolean | undefined,
  hint: GoalReplaceHint | undefined,
): void {
  if (incomingGoal === undefined && incomingConfirmed === undefined) return;

  const ig = incomingGoal?.trim();
  const ic = incomingConfirmed ?? false;

  if (!ig && incomingGoal === undefined) return;
  const goalText = ig ?? '';

  const curG = current.researchGoal;
  const curC = current.goalConfirmed;

  if (curG === undefined || curG.trim().length === 0) {
    current.researchGoal = goalText || curG;
    current.goalConfirmed = ic;
    return;
  }

  if (!curC && ic) {
    current.researchGoal = goalText || curG;
    current.goalConfirmed = true;
    return;
  }

  if (curC && !ic) {
    return;
  }

  if (curC && ic) {
    if (hint === 'replace') {
      current.researchGoal = goalText || curG;
      current.goalConfirmed = true;
      return;
    }
    // hint='keep' or hint='unknown' (or undefined): 默认 keep，不走 Jaccard
    // reviewer 已给出语义判断但选择不替换，或无法判断时，已确认目标被误替换的代价
    // 远高于延迟一回合再替换。下一回合 reviewer 大概率给出更明确的 hint。
    return;
  }

  if (!curC && !ic) {
    current.researchGoal = goalText || curG;
    current.goalConfirmed = false;
  }
}

export function mergeMethodology(
  current: SessionAnchors,
  incoming: string | undefined,
  threshold: number,
): void {
  if (incoming === undefined) return;
  const inc = incoming.trim();
  if (!inc) return;
  if (!current.methodology) {
    current.methodology = inc;
    return;
  }
  if (shouldReplaceMonotonic(current.methodology, inc, threshold)) {
    current.methodology = inc;
  }
}

export class SessionAnchorsRegistry {
  private readonly bySession = new Map<string, SessionAnchors>();

  view(sessionId: string): Readonly<SessionAnchors> {
    let a = this.bySession.get(sessionId);
    if (!a) {
      a = emptyAnchors();
      this.bySession.set(sessionId, a);
    }
    return a;
  }

  enqueueBlock(sessionId: string, block: PendingBlock): void {
    const a = this.view(sessionId) as SessionAnchors;
    a.pendingPrependBlocks.push(block);
  }

  drainBlocks(sessionId: string): PendingBlock[] {
    const a = this.bySession.get(sessionId);
    if (!a || a.pendingPrependBlocks.length === 0) return [];
    const out = [...a.pendingPrependBlocks];
    a.pendingPrependBlocks = [];
    return out;
  }

  pushReviewReport(sessionId: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    const a = this.view(sessionId) as SessionAnchors;
    a.recentReviewReports.push(t);
    if (a.recentReviewReports.length > ANCHOR_CAPS.reviewReports) {
      a.recentReviewReports = a.recentReviewReports.slice(-ANCHOR_CAPS.reviewReports);
    }
  }

  merge(sessionId: string, patch: StagedAnchorPatch): void {
    const a = this.view(sessionId) as SessionAnchors;
    const hint = patch._goalReplaceHint;
    const { _goalReplaceHint: _h, ...rest } = patch;

    if (rest.researchGoal !== undefined || rest.goalConfirmed !== undefined) {
      mergeGoal(a, rest.researchGoal, rest.goalConfirmed, hint);
    }

    if (rest.methodology !== undefined) {
      mergeMethodology(a, rest.methodology, METHODOLOGY_REPLACE_THRESHOLD);
    }

    if (rest.targetConclusions) {
      for (const t of rest.targetConclusions) {
        dedupAppend(a.targetConclusions, t, ANCHOR_CAPS.target);
      }
    }
    if (rest.keyConclusions) {
      for (const t of rest.keyConclusions) {
        dedupAppend(a.keyConclusions, t, ANCHOR_CAPS.conclusions);
      }
    }
    if (rest.userPreferences) {
      for (const t of rest.userPreferences) {
        dedupAppend(a.userPreferences, t, ANCHOR_CAPS.preferences);
      }
    }
    if (rest.methodologyDecisions) {
      for (const t of rest.methodologyDecisions) {
        dedupAppend(a.methodologyDecisions, t, ANCHOR_CAPS.methodologyDecisions);
      }
    }
    if (rest.recentSummaries && rest.recentSummaries.length > 0) {
      for (const s of rest.recentSummaries) {
        a.recentSummaries.push(s);
      }
      if (a.recentSummaries.length > ANCHOR_CAPS.summaries) {
        a.recentSummaries = a.recentSummaries.slice(-ANCHOR_CAPS.summaries);
      }
    }
  }

  drop(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  listSessions(): string[] {
    return [...this.bySession.keys()];
  }
}
