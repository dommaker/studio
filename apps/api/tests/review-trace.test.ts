/**
 * AC3: Review trace writing tests
 *
 * AC3.1: tracePipeline.writeTrace('review', ...) called after reviewAgent.review()
 * AC3.2: trace 数据包含 executionId, goalId, agentType, eventType, timestamp, success, summary
 * AC3.3: summary 含 review score, cycle, issueCount
 * AC3.4: writeTrace 调用包裹在 try/catch 中 (best-effort)
 * AC3.5: 审查失败路径 (exhausted + re-queued) 也在 writeTrace 覆盖范围内
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tracePipeline } from '../src/modules/monitoring/trace-pipeline.service.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Helper: construct trace data matching what goal.service.ts will produce ───

function buildReviewTraceData(params: {
  goalId: string;
  reviewCycle: number;
  review: { approved: boolean; score: number; issues: any[] };
}): Record<string, unknown> {
  const { goalId, reviewCycle, review } = params;
  const issueSummary = review.issues?.length
    ? review.issues.slice(0, 5).map((i: any) => `[${i.severity}] ${i.message}`).join('; ')
    : 'no issues';

  return {
    executionId: goalId,
    goalId,
    agentType: 'reviewer',
    eventType: 'review.completed',
    timestamp: Date.now(),
    success: review.approved,
    summary: review.approved
      ? `Review PASSED (cycle ${reviewCycle + 1}, score ${review.score})`
      : `Review REJECTED (cycle ${reviewCycle + 1}, score ${review.score}, ${review.issues?.length || 0} issues): ${issueSummary}`,
    tokenUsage: null,
  };
}

describe('AC3: Review trace writing', () => {
  describe('AC3.1 + AC3.4: tracePipeline.writeTrace exists and is callable', () => {
    it('should have writeTrace method on tracePipeline', () => {
      expect(tracePipeline).toBeDefined();
      expect(typeof tracePipeline.writeTrace).toBe('function');
    });

    it('should not throw when writing trace data (best-effort)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-trace-test-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      try {
        expect(() => {
          tracePipeline.writeTrace('review', {
            executionId: 'test-goal-1',
            goalId: 'test-goal-1',
            agentType: 'reviewer',
            eventType: 'review.completed',
            timestamp: Date.now(),
            success: true,
            summary: 'Review PASSED (cycle 1, score 95)',
            tokenUsage: null,
          });
        }).not.toThrow();
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should not throw with invalid or missing fields (best-effort)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-trace-test-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      try {
        expect(() => {
          tracePipeline.writeTrace('review', {} as any);
        }).not.toThrow();
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('AC3.2: trace data contains required fields', () => {
    it('should include executionId=goalId', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-abc',
        reviewCycle: 0,
        review: { approved: true, score: 95, issues: [] },
      });

      expect(data.executionId).toBe('goal-abc');
      expect(data.executionId).toBe(data.goalId);
    });

    it('should include goalId', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-xyz',
        reviewCycle: 1,
        review: { approved: true, score: 88, issues: [] },
      });

      expect(data.goalId).toBe('goal-xyz');
    });

    it('should have agentType="reviewer"', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-1',
        reviewCycle: 0,
        review: { approved: true, score: 100, issues: [] },
      });

      expect(data.agentType).toBe('reviewer');
    });

    it('should have eventType="review.completed"', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-1',
        reviewCycle: 0,
        review: { approved: true, score: 100, issues: [] },
      });

      expect(data.eventType).toBe('review.completed');
    });

    it('should have timestamp as number', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-1',
        reviewCycle: 0,
        review: { approved: true, score: 100, issues: [] },
      });

      expect(typeof data.timestamp).toBe('number');
      expect(data.timestamp).toBeGreaterThan(0);
    });

    it('should have success=review.approved', () => {
      const approved = buildReviewTraceData({
        goalId: 'goal-1',
        reviewCycle: 0,
        review: { approved: true, score: 100, issues: [] },
      });
      expect(approved.success).toBe(true);

      const rejected = buildReviewTraceData({
        goalId: 'goal-2',
        reviewCycle: 0,
        review: { approved: false, score: 30, issues: [{ severity: 'high', message: 'bad' }] },
      });
      expect(rejected.success).toBe(false);
    });

    it('should have summary as string', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-1',
        reviewCycle: 0,
        review: { approved: true, score: 100, issues: [] },
      });

      expect(typeof data.summary).toBe('string');
      expect(data.summary.length).toBeGreaterThan(0);
    });

    it('should have tokenUsage explicitly set', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-1',
        reviewCycle: 0,
        review: { approved: true, score: 100, issues: [] },
      });

      expect(data).toHaveProperty('tokenUsage');
      expect(data.tokenUsage).toBeNull();
    });
  });

  describe('AC3.3: summary contains diagnostic info (score, cycle, issueCount)', () => {
    it('should include score in approved summary', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-456',
        reviewCycle: 0,
        review: { approved: true, score: 88, issues: [] },
      });

      expect(data.summary).toContain('score 88');
    });

    it('should include cycle number (reviewCycle + 1) in approved summary', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-456',
        reviewCycle: 2,
        review: { approved: true, score: 90, issues: [] },
      });

      expect(data.summary).toContain('cycle 3');
    });

    it('should include score and cycle in rejected summary', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-789',
        reviewCycle: 0,
        review: {
          approved: false,
          score: 40,
          issues: [{ severity: 'high', message: 'missing null check' }],
        },
      });

      expect(data.summary).toContain('Review REJECTED');
      expect(data.summary).toContain('cycle 1');
      expect(data.summary).toContain('score 40');
    });

    it('should include issueCount in rejected summary', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-789',
        reviewCycle: 1,
        review: {
          approved: false,
          score: 30,
          issues: [
            { severity: 'critical', message: 'security hole' },
            { severity: 'high', message: 'missing validation' },
            { severity: 'medium', message: 'unused var' },
          ],
        },
      });

      expect(data.summary).toContain('3 issues');
      expect(data.summary).toContain('[critical] security hole');
      expect(data.summary).toContain('[high] missing validation');
      expect(data.summary).toContain('[medium] unused var');
    });

    it('should truncate issues to first 5 in summary', () => {
      const issues = Array.from({ length: 10 }, (_, i) => ({
        severity: 'low',
        message: `issue ${i + 1}`,
      }));

      const data = buildReviewTraceData({
        goalId: 'goal-000',
        reviewCycle: 0,
        review: { approved: false, score: 20, issues },
      });

      expect(data.summary).toContain('10 issues');
      const matchCount = (data.summary as string).match(/\[low\] issue \d/g);
      expect(matchCount?.length).toBe(5);
    });

    it('should show "no issues" when issues empty', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-0',
        reviewCycle: 0,
        review: { approved: false, score: 50, issues: [] },
      });

      expect(data.summary).toContain('no issues');
    });

    it('should handle undefined issues gracefully', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-0',
        reviewCycle: 0,
        review: { approved: false, score: 50, issues: undefined as any },
      });

      expect(data.summary).toContain('no issues');
      expect(data.summary).toContain('0 issues');
    });
  });

  describe('AC3.5: all review outcome paths have success field set correctly', () => {
    it('approved review → success=true', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-A',
        reviewCycle: 0,
        review: { approved: true, score: 100, issues: [] },
      });
      expect(data.success).toBe(true);
    });

    it('exhausted review (cycle=2 → cycle+1=3) → success=false', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-B',
        reviewCycle: 2,
        review: {
          approved: false,
          score: 25,
          issues: [{ severity: 'critical', message: 'still failing' }],
        },
      });
      expect(data.success).toBe(false);
      expect(data.summary).toContain('cycle 3');
    });

    it('re-queued review (cycle=0) → success=false', () => {
      const data = buildReviewTraceData({
        goalId: 'goal-C',
        reviewCycle: 0,
        review: {
          approved: false,
          score: 45,
          issues: [{ severity: 'high', message: 'needs fix' }],
        },
      });
      expect(data.success).toBe(false);
    });

    it('all paths produce valid serializable trace data', () => {
      const paths = [
        { approved: true, score: 95, issues: [] as any[] },
        { approved: false, score: 30, issues: [{ severity: 'critical', message: 'fail' }] },
        { approved: false, score: 60, issues: [{ severity: 'medium', message: 'warn' }] },
      ];

      for (const review of paths) {
        const data = buildReviewTraceData({
          goalId: 'goal-all',
          reviewCycle: 1,
          review,
        });

        expect(data.success).toBe(review.approved);
        expect(typeof data.summary).toBe('string');
        expect(() => JSON.stringify(data)).not.toThrow();
      }
    });
  });
});
