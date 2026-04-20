/**
 * Dual Model Supervisor — Reviewer Response Validators
 *
 * Narrow shape-validators for LLM JSON responses.
 * Each validator returns a sanitized object or null if the shape is invalid.
 */

import type { ReviewResult, ToolReviewResult, ConsistencyCheckResult, MessageSummary, GatekeeperResult, MemoryLossItem, MemoryItem, TaskParsingResult } from './types.js';

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !isNaN(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === 'string');
}

function clamp01(v: unknown): number {
  if (!isNumber(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Validate and sanitize a ReviewResult from the reviewer model.
 * Returns null if the response is fundamentally invalid.
 */
export function validateReviewResult(raw: unknown): ReviewResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // `blocked` must be boolean — if not, fail-safe to not-blocked
  const blocked = isBoolean(r.blocked) ? r.blocked : false;
  const corrected = isBoolean(r.corrected) ? r.corrected : false;

  // deviationScore: preserve null/undefined semantics; only clamp valid numbers
  let deviationScore: number | null | undefined;
  if (r.deviationScore === null) {
    deviationScore = null;
  } else if (r.deviationScore === undefined) {
    deviationScore = undefined;
  } else if (isNumber(r.deviationScore)) {
    deviationScore = Math.max(0, Math.min(1, r.deviationScore));
  } else {
    deviationScore = undefined;
  }

  return {
    blocked,
    corrected,
    correctionNote: isString(r.correctionNote) ? r.correctionNote : undefined,
    warnings: asStringArray(r.warnings),
    memoryAlerts: asStringArray(r.memoryAlerts),
    deviationScore,
    qualityScore: clamp01(r.qualityScore),
    reportText: isString(r.reportText) ? r.reportText : undefined,
  };
}

/**
 * Validate a ToolReviewResult. Extra security: correctedParams keys must be
 * a subset of the original tool parameters to prevent parameter injection.
 */
export function validateToolReviewResult(
  raw: unknown,
  originalParamKeys: string[],
): ToolReviewResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const blocked = isBoolean(r.blocked) ? r.blocked : false;

  let correctedParams: Record<string, unknown> | undefined;
  if (r.correctedParams && typeof r.correctedParams === 'object' && !Array.isArray(r.correctedParams)) {
    // Only accept keys that exist in the original params
    const filtered: Record<string, unknown> = {};
    const cp = r.correctedParams as Record<string, unknown>;
    let hasValidKey = false;
    for (const key of Object.keys(cp)) {
      if (originalParamKeys.includes(key)) {
        filtered[key] = cp[key];
        hasValidKey = true;
      }
    }
    correctedParams = hasValidKey ? filtered : undefined;
  }

  return {
    blocked,
    blockReason: isString(r.blockReason) ? r.blockReason : undefined,
    correctedParams,
    warnings: asStringArray(r.warnings),
  };
}

/**
 * Validate a ConsistencyCheckResult.
 */
export function validateConsistencyResult(raw: unknown): ConsistencyCheckResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  return {
    hasIssue: isBoolean(r.hasIssue) ? r.hasIssue : false,
    correction: isString(r.correction) ? r.correction : undefined,
    details: asStringArray(r.details),
  };
}

/**
 * Validate a TaskParsingResult (goal parser response).
 */
export function validateTaskParsingResult(raw: unknown): TaskParsingResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // researchGoal: allow empty string (greeting/acknowledgment scenarios), only return null when not a string
  const researchGoal = isString(r.researchGoal) ? r.researchGoal.trim() : undefined;
  if (researchGoal === undefined) return null; // only invalid when field is missing or wrong type

  const vsCurrentGoal = isString(r.vsCurrentGoal) && ['replace', 'keep', 'unknown'].includes(r.vsCurrentGoal)
    ? (r.vsCurrentGoal as 'replace' | 'keep' | 'unknown')
    : undefined;

  return {
    researchGoal,
    targetConclusions: asStringArray(r.targetConclusions),
    methodology: isString(r.methodology) && r.methodology.trim() ? r.methodology.trim() : undefined,
    vsCurrentGoal,
  };
}

/**
 * Validate a MessageSummary (summary extractor response).
 */
export function validateMessageSummary(raw: unknown): MessageSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // Validate decisionKinds: must be an array of valid enum values
  let decisionKinds: Array<'methodology' | 'conclusion' | 'other'> | undefined;
  if (Array.isArray(r.decisionKinds)) {
    const validKinds: Array<'methodology' | 'conclusion' | 'other'> = [];
    for (const kind of r.decisionKinds) {
      if (kind === 'methodology' || kind === 'conclusion' || kind === 'other') {
        validKinds.push(kind);
      }
    }
    if (validKinds.length > 0) {
      decisionKinds = validKinds;
    }
  }

  return {
    claims: asStringArray(r.claims),
    decisions: asStringArray(r.decisions),
    decisionKinds,
    references: asStringArray(r.references),
    conditions: asStringArray(r.conditions),
    reasoning: asStringArray(r.reasoning),
    limitations: asStringArray(r.limitations),
    negations: asStringArray(r.negations),
    nextSteps: asStringArray(r.nextSteps),
  };
}

/**
 * Validate memory loss items from after_compaction review.
 */
export function validateMemoryLossItems(raw: unknown): MemoryLossItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  const items = r.lostItems;
  if (!Array.isArray(items)) return [];

  const validImportances: Array<'critical' | 'high'> = ['critical', 'high'];

  return items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .filter((item) => isString(item.category) && isString(item.content))
    .map((item) => ({
      category: item.category as string,
      content: item.content as string,
      importance: validImportances.includes(item.importance as 'critical' | 'high')
        ? (item.importance as 'critical' | 'high')
        : 'high', // default to 'high' if invalid or missing
    }));
}

/**
 * Validate key memory items from before_compaction review.
 */
export function validateKeyMemoryItems(raw: unknown): MemoryItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  const items = r.keyItems;
  if (!Array.isArray(items)) return [];

  return items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .filter((item) => isString(item.category) && isString(item.summary))
    .map((item) => ({
      category: item.category as string,
      summary: item.summary as string,
    }));
}

/**
 * Validate course correction / deviation analysis response.
 */
export function validateDeviationAnalysis(raw: unknown): {
  deviation: number;
  memoryLoss: boolean;
  qualityScore: number;
  courseCorrection: string;
  summary: string;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  return {
    deviation: clamp01(r.deviation),
    memoryLoss: isBoolean(r.memoryLoss) ? r.memoryLoss : false,
    qualityScore: clamp01(r.qualityScore),
    courseCorrection: isString(r.courseCorrection) ? r.courseCorrection : '',
    summary: isString(r.summary) ? r.summary : '',
  };
}

/**
 * Validate force-regenerate correction instruction response.
 */
export function validateForceRegenerateCorrection(raw: unknown): {
  correctionInstruction: string;
  deviationSummary: string;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const correctionInstruction = isString(r.correctionInstruction) ? r.correctionInstruction.trim() : '';
  if (!correctionInstruction) return null;

  return {
    correctionInstruction,
    deviationSummary: isString(r.deviationSummary) ? r.deviationSummary : '',
  };
}

/**
 * Validate a GatekeeperResult from the reviewer model.
 */
export function validateGatekeeperResult(raw: unknown): GatekeeperResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const needReview = isBoolean(r.needReview) ? r.needReview : false;
  const reason = isString(r.reason) ? r.reason : '';

  return {
    needReview,
    reason,
  };
}

/**
 * Validate target conclusion drift check response.
 */
export function validateTargetConclusionCheck(raw: unknown): {
  progressAssessment: string;
  addressedTargets: string[];
  unaddressedTargets: string[];
  driftDetected: boolean;
  driftDetails: string;
  suggestedNewTargets: string[];
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  return {
    progressAssessment: isString(r.progressAssessment) ? r.progressAssessment : '',
    addressedTargets: asStringArray(r.addressedTargets),
    unaddressedTargets: asStringArray(r.unaddressedTargets),
    driftDetected: isBoolean(r.driftDetected) ? r.driftDetected : false,
    driftDetails: isString(r.driftDetails) ? r.driftDetails : '',
    suggestedNewTargets: asStringArray(r.suggestedNewTargets),
  };
}
