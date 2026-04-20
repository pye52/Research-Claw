/**
 * Anchor context lines — format SessionAnchors for reviewer / prepend prompts.
 */

import type { SessionAnchors } from '../core/session-anchors.js';

/**
 * Build context lines from session anchors (research goal, targets, methodology, preferences).
 */
export function buildAnchorContextLines(anchors: Readonly<SessionAnchors>): string[] {
  const lines: string[] = [];

  if (anchors.researchGoal) {
    lines.push(`Research goal: ${anchors.researchGoal}`);
  }
  if (anchors.targetConclusions.length > 0) {
    lines.push(`Target conclusions: ${anchors.targetConclusions.join('; ')}`);
  }
  if (anchors.methodology) {
    lines.push(`Initial methodology: ${anchors.methodology}`);
  }
  if (anchors.methodologyDecisions.length > 0) {
    lines.push(`Established methodology decisions: ${anchors.methodologyDecisions.join('; ')}`);
  }
  if (anchors.userPreferences.length > 0) {
    lines.push(`User preferences you must honor: ${anchors.userPreferences.join('; ')}`);
  }
  if (anchors.keyConclusions.length > 0) {
    lines.push(`Key conclusions reached: ${anchors.keyConclusions.join('; ')}`);
  }

  return lines;
}
