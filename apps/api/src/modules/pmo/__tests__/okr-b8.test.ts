// B8 OKR 核心逻辑测试
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../../core/database.js';
import { OKRService, getCurrentQuarter } from '../okr.service.js';
import type { OKRKeyResult } from '../okr.service.js';

const service = new OKRService();
let testCompanyId: string;

describe('B8 OKR Service', () => {
  beforeAll(async () => {
    const company = await prisma.company.findFirst();
    if (!company) {
      const c = await prisma.company.create({ data: { name: 'B8 Test Corp' } });
      testCompanyId = c.id;
    } else {
      testCompanyId = company.id;
    }
  });

  describe('checkDataSourceHealth', () => {
    it('returns ok/empty for all 4 data sources', async () => {
      const health = await service.checkDataSourceHealth();
      expect(health).toHaveProperty('pipeline_run');
      expect(health).toHaveProperty('studio_event');
      expect(health).toHaveProperty('goal');
      expect(health).toHaveProperty('goal_execution');
      // pipeline_run must be ok (we have data)
      expect(health.pipeline_run).toBe('ok');
    });
  });

  describe('validateKRTarget', () => {
    it('blocks target below baseline (R1)', async () => {
      const kr: OKRKeyResult = {
        id: 'test-r1', objectiveId: 'o1', title: 'cache hit too low',
        target: 40, current: 0, unit: '%', metricType: 'cache_hit_rate',
      };
      const result = await service.validateKRTarget(kr);
      expect(result.status).toBe('blocked');
      expect(result.reasons[0]).toContain('低于当前水平');
    });

    it('warns when target far from baseline (R2)', async () => {
      const kr: OKRKeyResult = {
        id: 'test-r2', objectiveId: 'o1', title: 'too aggressive',
        target: 100, current: 0, unit: '%', metricType: 'execution_success_rate',
      };
      const result = await service.validateKRTarget(kr);
      expect(['warning', 'blocked']).toContain(result.status);
    });

    it('blocks when data source is empty (R3)', async () => {
      const kr: OKRKeyResult = {
        id: 'test-r3', objectiveId: 'o1', title: 'token saving',
        target: 60, current: 0, unit: '%', metricType: 'token_saving_ratio',
      };
      const result = await service.validateKRTarget(kr);
      expect(result.status).toBe('blocked');
      expect(result.reasons[0]).toContain('为空');
    });

    it('blocks target <= 0 (R4)', async () => {
      const kr: OKRKeyResult = {
        id: 'test-r4', objectiveId: 'o1', title: 'invalid',
        target: 0, current: 0, unit: '%', metricType: 'cache_hit_rate',
      };
      const result = await service.validateKRTarget(kr);
      expect(result.status).toBe('blocked');
    });

    it('passes for manual KRs (no metricType)', async () => {
      const kr: OKRKeyResult = {
        id: 'test-manual', objectiveId: 'o1', title: 'manual',
        target: 50, current: 0, unit: '%', metricType: '',
      };
      const result = await service.validateKRTarget(kr);
      expect(result.status).toBe('pass');
    });
  });

  describe('getMetricBaseline', () => {
    it('returns number for cache_hit_rate', async () => {
      const baseline = await service.getMetricBaseline('cache_hit_rate');
      expect(baseline).not.toBeNull();
      expect(typeof baseline).toBe('number');
      // Should be 0-100 (percentage)
      expect(baseline!).toBeGreaterThanOrEqual(0);
      expect(baseline!).toBeLessThanOrEqual(100);
    });

    it('returns number for execution_success_rate', async () => {
      const baseline = await service.getMetricBaseline('execution_success_rate');
      expect(baseline).not.toBeNull();
      expect(typeof baseline).toBe('number');
    });

    it('returns null for unknown metricType', async () => {
      const baseline = await service.getMetricBaseline('nonexistent');
      expect(baseline).toBeNull();
    });
  });

  describe('syncKRProgress', () => {
    it('handles non-existent OKR gracefully', async () => {
      await expect(service.syncKRProgress('non-existent-id')).rejects.toThrow('not found');
    });

    it('syncs pipeline OKR and returns mixed statuses', async () => {
      const results = await service.syncKRProgress('okr-pipeline-001');
      expect(results.length).toBe(6);
      const statuses = results.map(r => r.status);
      // At least some should be 'ok' (we have pipeline_run/goal data)
      expect(statuses).toContain('ok');
      // token_saving_ratio should be no_data (StudioEvent empty)
      expect(statuses).toContain('no_data');
    });
  });

  describe('recalibration', () => {
    it('detects when baseline exceeds target', async () => {
      const suggestions = await service.getRecalibrationSuggestions('okr-pipeline-001');
      // pipeline_duration_p90 actual ~50min vs target 10min → should suggest increase
      const durationSuggestion = suggestions.find(s => s.includes('管线 e2e'));
      expect(durationSuggestion).toBeTruthy();
      expect(durationSuggestion).toContain('建议上调');
    });
  });

  describe('getCurrentQuarter', () => {
    it('returns YYYY-QN format', () => {
      const q = getCurrentQuarter();
      expect(q).toMatch(/^\d{4}-Q[1-4]$/);
    });
  });
});
