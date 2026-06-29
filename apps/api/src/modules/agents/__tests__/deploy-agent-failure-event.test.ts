/**
 * T3: Deploy failure event carries FailureClass + metricType deploy_failure_rate registered
 *
 * AC-1: classifyFailureAction produces valid FailureClass for deploy error patterns
 * AC-2: deploy_success_rate and deploy_failure_rate are both registered in METRIC_REGISTRY
 * AC-3: queryDeploySuccessRate parses top-level payload.success (not payload.result.success)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyFailureAction, type FailureClass } from '../../shared/failure-classifier.js';
import { OKRService } from '../../pmo/okr.service.js';
import { prisma } from '../../../core/database.js';

describe('T3: Deploy failure event enrichment', () => {
  // -- AC-1: FailureClass classification for deploy errors --

  describe('classifyFailureAction for deploy error patterns', () => {
    it('classifies ECONNREFUSED as infrastructure', () => {
      const result = classifyFailureAction('git push failed: ECONNREFUSED 127.0.0.1:22');
      expect(result.failureClass).toBe('infrastructure');
      expect(result.action).toBe('retry-execution');
    });

    it('classifies ETIMEDOUT as retryable', () => {
      const result = classifyFailureAction('git push failed: ETIMEDOUT after 120s');
      expect(result.failureClass).toBe('retryable');
      expect(result.action).toBe('retry-execution');
    });

    it('classifies "does not exist" as not-retryable', () => {
      const result = classifyFailureAction('remote branch origin/master does not exist');
      expect(result.failureClass).toBe('not-retryable');
      expect(result.action).toBe('mark-blocked');
    });

    it('classifies unrecognized error as unknown', () => {
      const result = classifyFailureAction('something weird happened with git');
      expect(result.failureClass).toBe('unknown');
      expect(result.action).toBe('triage-agent');
    });

    it('classifies worktree lost as infrastructure (checked before generic ENOENT)', () => {
      const result = classifyFailureAction('worktree ENOENT: /path/to/worktree');
      expect(result.failureClass).toBe('infrastructure');
    });

    it('returns all valid FailureClass values', () => {
      const classes = new Set<FailureClass>();
      const errors = [
        'ECONNREFUSED', 'timeout', 'does not exist', 'random gibberish',
      ];
      for (const err of errors) {
        classes.add(classifyFailureAction(err).failureClass);
      }
      expect(classes.size).toBeGreaterThanOrEqual(3);
    });
  });

  // -- AC-2: metricType registration --

  describe('deploy metricType registration', () => {
    it('deploy_success_rate is registered', () => {
      expect(OKRService.METRIC_REGISTRY).toHaveProperty('deploy_success_rate');
      expect(OKRService.METRIC_REGISTRY['deploy_success_rate'].dataSource).toBe('studio_event');
    });

    it('deploy_failure_rate is registered', () => {
      expect(OKRService.METRIC_REGISTRY).toHaveProperty('deploy_failure_rate');
      expect(OKRService.METRIC_REGISTRY['deploy_failure_rate'].dataSource).toBe('studio_event');
    });

    it('UPPER_BOUNDS covers deploy_failure_rate', () => {
      const bounds = (OKRService as unknown as { UPPER_BOUNDS: Record<string, number> }).UPPER_BOUNDS;
      expect(bounds).toHaveProperty('deploy_failure_rate');
      expect(bounds['deploy_failure_rate']).toBe(100);
    });
  });

  // -- AC-3: queryDeploySuccessRate payload parsing --

  describe('queryDeploySuccessRate payload parsing', () => {
    const seededEventIds: string[] = [];

    beforeEach(async () => {
      // Seed deploy.completed events with top-level success field (matching actual payload format)
      const successEvent = await prisma.studioEvent.create({
        data: {
          type: 'deploy.completed',
          source: 'deploy-agent',
          payload: JSON.stringify({ success: true, type: 'vps', durationMs: 5000 }),
        },
      });
      const failEvent = await prisma.studioEvent.create({
        data: {
          type: 'deploy.completed',
          source: 'deploy-agent',
          payload: JSON.stringify({ success: false, type: 'vps', durationMs: 15000, failureClass: 'retryable' }),
        },
      });
      seededEventIds.push(successEvent.id, failEvent.id);
    });

    afterEach(async () => {
      await prisma.studioEvent.deleteMany({ where: { id: { in: seededEventIds } } });
      seededEventIds.length = 0;
    });

    it('returns non-null deploy_success_rate when events exist', async () => {
      const service = new OKRService();
      const baseline = await service.getMetricBaseline('deploy_success_rate');
      expect(baseline).not.toBeNull();
      expect(typeof baseline).toBe('number');
      expect(baseline!).toBeGreaterThanOrEqual(0);
      expect(baseline!).toBeLessThanOrEqual(100);
    });

    it('returns non-null deploy_failure_rate when events exist', async () => {
      const service = new OKRService();
      const baseline = await service.getMetricBaseline('deploy_failure_rate');
      expect(baseline).not.toBeNull();
      expect(typeof baseline).toBe('number');
      expect(baseline!).toBeGreaterThanOrEqual(0);
      expect(baseline!).toBeLessThanOrEqual(100);
    });

    it('deploy_success_rate + deploy_failure_rate = 100', async () => {
      const service = new OKRService();
      const successRate = await service.getMetricBaseline('deploy_success_rate');
      const failureRate = await service.getMetricBaseline('deploy_failure_rate');
      expect(successRate).not.toBeNull();
      expect(failureRate).not.toBeNull();
      // Complementary: success + failure = 100 (same denominator)
      expect(successRate! + failureRate!).toBe(100);
    });
  });
});
