import { describe, expect, it } from 'vitest';
import {
  validateReviewResult,
  validateToolReviewResult,
  validateConsistencyResult,
  validateTaskParsingResult,
  validateMessageSummary,
  validateMemoryLossItems,
  validateKeyMemoryItems,
  validateDeviationAnalysis,
  validateGatekeeperResult,
  validateTargetConclusionCheck,
} from '../core/validators.js';

describe('validateReviewResult', () => {
  it('accepts valid response', () => {
    const r = validateReviewResult({
      blocked: false,
      corrected: false,
      warnings: ['test warning'],
      memoryAlerts: [],
      deviationScore: 0.3,
      qualityScore: 0.9,
      reportText: 'Looks good',
    });
    expect(r).not.toBeNull();
    expect(r!.blocked).toBe(false);
    expect(r!.warnings).toEqual(['test warning']);
    expect(r!.deviationScore).toBe(0.3);
  });

  it('sanitizes non-boolean blocked to false (fail-safe)', () => {
    const r = validateReviewResult({ blocked: 'yes', corrected: 'true' });
    expect(r!.blocked).toBe(false);
    expect(r!.corrected).toBe(false);
  });

  it('clamps scores to 0-1 range', () => {
    const r = validateReviewResult({ blocked: false, deviationScore: 5.0, qualityScore: -1 });
    expect(r!.deviationScore).toBe(1);
    expect(r!.qualityScore).toBe(0);
  });

  it('returns null for non-object input', () => {
    expect(validateReviewResult(null)).toBeNull();
    expect(validateReviewResult('string')).toBeNull();
    expect(validateReviewResult(42)).toBeNull();
  });

  it('filters non-string items from warnings array', () => {
    const r = validateReviewResult({ blocked: false, warnings: ['valid', 42, null, 'also valid'] });
    expect(r!.warnings).toEqual(['valid', 'also valid']);
  });

  it('preserves null deviationScore', () => {
    const r = validateReviewResult({ blocked: false, deviationScore: null });
    expect(r!.deviationScore).toBeNull();
  });

  it('preserves undefined deviationScore', () => {
    const r = validateReviewResult({ blocked: false });
    expect(r!.deviationScore).toBeUndefined();
  });
});

describe('validateToolReviewResult', () => {
  const originalKeys = ['command', 'path', 'content'];

  it('accepts valid response', () => {
    const r = validateToolReviewResult(
      { blocked: false, warnings: [] },
      originalKeys,
    );
    expect(r).not.toBeNull();
    expect(r!.blocked).toBe(false);
  });

  it('filters correctedParams to only original keys (prevents injection)', () => {
    const r = validateToolReviewResult(
      {
        blocked: false,
        correctedParams: {
          command: 'ls -la',        // allowed — exists in original
          path: '/safe/path',       // allowed
          injectedKey: 'malicious', // MUST be filtered out
          __proto__: {},            // MUST be filtered out
        },
        warnings: [],
      },
      originalKeys,
    );
    expect(r).not.toBeNull();
    expect(r!.correctedParams).toEqual({ command: 'ls -la', path: '/safe/path' });
    expect(r!.correctedParams).not.toHaveProperty('injectedKey');
    expect(r!.correctedParams).not.toHaveProperty('__proto__');
  });

  it('rejects correctedParams with no valid keys', () => {
    const r = validateToolReviewResult(
      { blocked: false, correctedParams: { evil: 'data' }, warnings: [] },
      originalKeys,
    );
    expect(r!.correctedParams).toBeUndefined();
  });

  it('handles blocked: "yes" as false (fail-safe)', () => {
    const r = validateToolReviewResult({ blocked: 'yes' }, originalKeys);
    expect(r!.blocked).toBe(false);
  });
});

describe('validateConsistencyResult', () => {
  it('accepts valid response', () => {
    const r = validateConsistencyResult({
      hasIssue: true,
      correction: 'Fix this',
      details: ['Issue 1'],
    });
    expect(r!.hasIssue).toBe(true);
    expect(r!.correction).toBe('Fix this');
  });

  it('defaults hasIssue to false for non-boolean', () => {
    const r = validateConsistencyResult({ hasIssue: 1 });
    expect(r!.hasIssue).toBe(false);
  });
});

describe('validateTaskParsingResult', () => {
  it('accepts valid response', () => {
    const r = validateTaskParsingResult({
      researchGoal: 'Study AI safety',
      targetConclusions: ['Conclusion 1'],
      methodology: 'Literature review',
    });
    expect(r).not.toBeNull();
    expect(r!.researchGoal).toBe('Study AI safety');
  });

  it('accepts empty researchGoal (greeting/acknowledgment scenarios)', () => {
    const r = validateTaskParsingResult({ researchGoal: '', targetConclusions: [] });
    expect(r).not.toBeNull();
    expect(r!.researchGoal).toBe('');
  });

  it('returns null for missing researchGoal', () => {
    expect(validateTaskParsingResult({ targetConclusions: ['x'] })).toBeNull();
  });

  it('validates vsCurrentGoal enum', () => {
    const r = validateTaskParsingResult({ researchGoal: 'Test', vsCurrentGoal: 'replace' });
    expect(r!.vsCurrentGoal).toBe('replace');
  });

  it('rejects invalid vsCurrentGoal values', () => {
    const r = validateTaskParsingResult({ researchGoal: 'Test', vsCurrentGoal: 'invalid' });
    expect(r!.vsCurrentGoal).toBeUndefined();
  });
});

describe('validateMessageSummary', () => {
  it('accepts valid response with all fields', () => {
    const r = validateMessageSummary({
      claims: ['Claim 1'],
      decisions: [],
      references: ['Ref 1'],
      conditions: [],
      reasoning: ['A therefore B'],
      limitations: ['Limit 1'],
      negations: ['Not X'],
      nextSteps: ['Step 1'],
    });
    expect(r).not.toBeNull();
    expect(r!.claims).toEqual(['Claim 1']);
    expect(r!.negations).toEqual(['Not X']);
  });

  it('returns empty arrays for missing fields', () => {
    const r = validateMessageSummary({});
    expect(r!.claims).toEqual([]);
    expect(r!.decisions).toEqual([]);
  });

  it('validates decisionKinds', () => {
    const r = validateMessageSummary({
      decisions: ['D1', 'D2'],
      decisionKinds: ['methodology', 'conclusion', 'invalid'],
    });
    expect(r!.decisionKinds).toEqual(['methodology', 'conclusion']);
  });
});

describe('validateMemoryLossItems', () => {
  it('extracts valid items', () => {
    const items = validateMemoryLossItems({
      lostItems: [
        { category: 'research_goal', content: 'Lost goal', importance: 'critical' },
        { category: 'key_conclusion', content: 'Lost fact' },  // missing importance → default high
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[1].importance).toBe('high');
  });

  it('filters invalid items', () => {
    const items = validateMemoryLossItems({
      lostItems: [
        { category: 123, content: 'bad category' },  // non-string category
        'not an object',
        null,
      ],
    });
    expect(items).toHaveLength(0);
  });
});

describe('validateKeyMemoryItems', () => {
  it('extracts valid items', () => {
    const items = validateKeyMemoryItems({
      keyItems: [
        { category: 'research_goal', summary: 'Goal summary', source: 'turn-1', timestamp: 1234567890 },
        { category: 'key_conclusion', summary: 'Conclusion summary' },  // missing optional fields
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0].category).toBe('research_goal');
    expect(items[1].summary).toBe('Conclusion summary');
  });

  it('filters invalid items', () => {
    const items = validateKeyMemoryItems({
      keyItems: [
        { category: 'test', summary: 123 },  // non-string summary
        null,
      ],
    });
    expect(items).toHaveLength(0);
  });
});

describe('validateDeviationAnalysis', () => {
  it('clamps deviation score', () => {
    const r = validateDeviationAnalysis({ deviation: 1.5, qualityScore: -0.2 });
    expect(r!.deviation).toBe(1);
    expect(r!.qualityScore).toBe(0);
  });

  it('accepts valid response', () => {
    const r = validateDeviationAnalysis({
      deviation: 0.7,
      memoryLoss: true,
      qualityScore: 0.3,
      courseCorrection: 'Stay on track',
      summary: 'Deviated significantly',
    });
    expect(r!.deviation).toBe(0.7);
    expect(r!.memoryLoss).toBe(true);
  });

  it('accepts correctionInstruction and deviationSummary when deviation exceeds threshold', () => {
    const r = validateDeviationAnalysis({
      deviation: 0.8,
      memoryLoss: false,
      qualityScore: 0.2,
      courseCorrection: 'Return to research goal',
      summary: 'Severe topic drift',
      correctionInstruction: 'You must focus on carbapenem resistance only',
      deviationSummary: 'Assistant pivoted to unrelated hypertension topic',
    });
    expect(r!.correctionInstruction).toBe('You must focus on carbapenem resistance only');
    expect(r!.deviationSummary).toBe('Assistant pivoted to unrelated hypertension topic');
  });

  it('returns empty strings for correctionInstruction and deviationSummary when not provided', () => {
    const r = validateDeviationAnalysis({
      deviation: 0.2,
      memoryLoss: false,
      qualityScore: 0.9,
      courseCorrection: '',
      summary: 'On track',
    });
    expect(r!.correctionInstruction).toBe('');
    expect(r!.deviationSummary).toBe('');
  });

  it('trims whitespace from correctionInstruction', () => {
    const r = validateDeviationAnalysis({
      deviation: 0.6,
      memoryLoss: false,
      qualityScore: 0.5,
      courseCorrection: '',
      summary: '',
      correctionInstruction: '  Stay on topic  ',
      deviationSummary: '  Deviated  ',
    });
    expect(r!.correctionInstruction).toBe('Stay on topic');
    expect(r!.deviationSummary).toBe('Deviated');
  });
});

describe('validateGatekeeperResult', () => {
  it('accepts valid response', () => {
    const r = validateGatekeeperResult({ needReview: true, reason: 'Contains research content' });
    expect(r!.needReview).toBe(true);
    expect(r!.reason).toBe('Contains research content');
  });

  it('defaults needReview to false for non-boolean', () => {
    const r = validateGatekeeperResult({ needReview: 'yes' });
    expect(r!.needReview).toBe(false);
  });
});

describe('validateTargetConclusionCheck', () => {
  it('accepts valid response', () => {
    const r = validateTargetConclusionCheck({
      progressAssessment: 'Good progress',
      addressedTargets: ['Target 1'],
      unaddressedTargets: ['Target 2'],
      driftDetected: true,
      driftDetails: 'Drifted from goal',
      suggestedNewTargets: ['New Target'],
    });
    expect(r!.driftDetected).toBe(true);
    expect(r!.addressedTargets).toEqual(['Target 1']);
  });

  it('defaults driftDetected to false for non-boolean', () => {
    const r = validateTargetConclusionCheck({ driftDetected: 'yes' });
    expect(r!.driftDetected).toBe(false);
  });
});
