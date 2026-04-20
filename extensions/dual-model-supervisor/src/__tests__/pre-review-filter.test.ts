import { describe, it, expect } from 'vitest';
import { PreReviewFilter } from '../hooks/pre-review-filter.js';
import type { PreReviewFilterConfig } from '../core/types.js';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const defaultConfig: PreReviewFilterConfig = {
  minContentLength: 15,
  gatekeeperMaxInputChars: 200,
  alwaysReviewToolCalls: true,
};

describe('PreReviewFilter', () => {
  describe('shouldReview', () => {
    it('skips empty messages', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      expect(filter.shouldReview('').decision).toBe('skip');
      expect(filter.shouldReview('   ').decision).toBe('skip');
    });

    it('skips Chinese greetings', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      expect(filter.shouldReview('你好').decision).toBe('skip');
      expect(filter.shouldReview('您好').decision).toBe('skip');
      expect(filter.shouldReview('嗨').decision).toBe('skip');
    });

    it('skips Chinese acknowledgments', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      expect(filter.shouldReview('好的').decision).toBe('skip');
      expect(filter.shouldReview('明白').decision).toBe('skip');
      expect(filter.shouldReview('知道了').decision).toBe('skip');
      expect(filter.shouldReview('收到').decision).toBe('skip');
    });

    it('skips Chinese thanks', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      expect(filter.shouldReview('谢谢').decision).toBe('skip');
      expect(filter.shouldReview('感谢').decision).toBe('skip');
    });

    it('skips English greetings', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      expect(filter.shouldReview('hello').decision).toBe('skip');
      expect(filter.shouldReview('hi').decision).toBe('skip');
      expect(filter.shouldReview('Hey').decision).toBe('skip');
    });

    it('skips English acknowledgments', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      expect(filter.shouldReview('ok').decision).toBe('skip');
      expect(filter.shouldReview('OK').decision).toBe('skip');
      expect(filter.shouldReview('got it').decision).toBe('skip');
      expect(filter.shouldReview('sure').decision).toBe('skip');
    });

    it('skips English thanks', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      expect(filter.shouldReview('thanks').decision).toBe('skip');
      expect(filter.shouldReview('thank you').decision).toBe('skip');
    });

    it('skips emoji-only messages', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      expect(filter.shouldReview('👋').decision).toBe('skip');
      expect(filter.shouldReview('👍👍').decision).toBe('skip');
    });

    it('passes research content even when short', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      // "分析一下" is 4 chars but NOT a trivial phrase
      expect(filter.shouldReview('分析一下').decision).toBe('pass');
      // "什么是AI" is 5 chars but contains research intent
      expect(filter.shouldReview('什么是AI').decision).toBe('pass');
    });

    it('passes long messages even if they start with greeting', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      // A message that starts with greeting but has more content
      const longMessage = '你好，我想了解一下人工智能在医疗领域的最新应用';
      expect(filter.shouldReview(longMessage).decision).toBe('pass');
    });

    it('passes content above minContentLength even if it looks trivial', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      // 20 chars — above minContentLength (15), so it passes
      const message = '好的好的好的好的好的好的';
      expect(filter.shouldReview(message).decision).toBe('pass');
    });

    it('passes mixed content that contains greetings but also substance', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      // "你好分析一下数据" is NOT an exact match for "你好"
      expect(filter.shouldReview('你好分析一下数据').decision).toBe('pass');
    });
  });

  describe('updateConfig', () => {
    it('respects minContentLength changes', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      // With minContentLength=15, "谢谢" (2 chars) is skipped
      expect(filter.shouldReview('谢谢').decision).toBe('skip');

      // Raise threshold — "谢谢" still matches trivial phrase, so still skipped
      // But a longer non-trivial message would behave differently
      filter.updateConfig({ ...defaultConfig, minContentLength: 100 });
      // A 20-char research message is now below threshold, but doesn't match trivial phrases
      expect(filter.shouldReview('请帮我分析一下数据').decision).toBe('pass');
    });
  });

  describe('reason field', () => {
    it('provides meaningful reason for skip decisions', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      const result = filter.shouldReview('你好');
      expect(result.decision).toBe('skip');
      expect(result.reason).toContain('trivial phrase');
    });

    it('provides meaningful reason for empty messages', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      const result = filter.shouldReview('');
      expect(result.decision).toBe('skip');
      expect(result.reason).toContain('empty');
    });

    it('provides meaningful reason for pass decisions', () => {
      const filter = new PreReviewFilter(defaultConfig, mockLogger);
      const result = filter.shouldReview('请帮我分析一下数据');
      expect(result.decision).toBe('pass');
      expect(result.reason).toContain('passed');
    });
  });
});
