// @ts-nocheck
import { describe, it, expect } from 'vitest';

describe('studio-meeting imports', () => {
  it('should export MeetingTimeoutChecker', async () => {
    const { MeetingTimeoutChecker } = await import('../services/meeting-timeout-checker.js');
    expect(MeetingTimeoutChecker).toBeDefined();
  });

  it('should export loadReviewRules', async () => {
    const { loadReviewRules } = await import('../services/review-rules-loader.js');
    expect(loadReviewRules).toBeDefined();
    expect(typeof loadReviewRules).toBe('function');
  });
});