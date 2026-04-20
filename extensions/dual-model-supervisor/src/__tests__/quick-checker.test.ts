import { describe, expect, it } from 'vitest';
import { QuickChecker } from '../hooks/quick-checker.js';

const defaultConfig = {
  enabled: true,
  supervisorModel: 'test/model',
  reviewMode: 'full' as const,
  appendReviewToChannelOutput: true,
  memoryGuard: { enabled: true, keyCategories: [] },
  courseCorrection: { enabled: true, deviationThreshold: 0.5, forceRegenerate: false, maxRegenerateAttempts: 3 },
  preReviewFilter: { minContentLength: 15, gatekeeperMaxInputChars: 200, alwaysReviewToolCalls: true },
  highRiskTools: ['exec', 'write', 'edit'],
};

const logger = { info: () => {}, warn: () => {}, error: () => {} };

describe('QuickChecker', () => {
  it('detects fork bomb pattern', () => {
    const checker = new QuickChecker(defaultConfig, logger);
    expect(checker.check(':(){ :|:& };:').blocked).toBe(true);
    expect(checker.check(':(){ :|:& }').blocked).toBe(true);
    expect(checker.check(':() { : | :& }').blocked).toBe(true);
  });

  it('detects rm -rf /', () => {
    const checker = new QuickChecker(defaultConfig, logger);
    expect(checker.check('rm -rf /').blocked).toBe(true);
    expect(checker.check('RM -RF /').blocked).toBe(true);
  });

  it('does not false-positive on safe content', () => {
    const checker = new QuickChecker(defaultConfig, logger);
    expect(checker.check('This is a normal research paper about bash scripting').blocked).toBe(false);
  });

  it('returns early when disabled', () => {
    const checker = new QuickChecker({ ...defaultConfig, enabled: false }, logger);
    expect(checker.check('rm -rf /').blocked).toBe(false);
  });

  it('checks tool calls for dangerous exec commands', () => {
    const checker = new QuickChecker(defaultConfig, logger);
    expect(checker.checkToolCall('exec', { command: 'rm -rf /' }).blocked).toBe(true);
    expect(checker.checkToolCall('exec', { command: 'ls -la' }).blocked).toBe(false);
  });

  it('blocks writes to system paths', () => {
    const checker = new QuickChecker(defaultConfig, logger);
    expect(checker.checkToolCall('write', { path: '/etc/passwd' }).blocked).toBe(true);
    expect(checker.checkToolCall('write', { path: '/home/user/file.txt' }).blocked).toBe(false);
  });

  it('detects privacy leakage patterns', () => {
    const checker = new QuickChecker(defaultConfig, logger);
    expect(checker.check('password: "secret123456"').blocked).toBe(true);
    expect(checker.check('api_key: "sk-1234567890abcdef"').blocked).toBe(true);
  });

  it('warns on fabricated citation patterns', () => {
    const checker = new QuickChecker(defaultConfig, logger);
    const result = checker.check('See doi: 10.1234/example (Author, 2024) for details');
    expect(result.blocked).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
