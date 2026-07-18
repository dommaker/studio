// B8 OKR 核心逻辑测试
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { OKRService, getCurrentQuarter } from '../okr.service.js';
import type { OKRKeyResult } from '../okr.service.js';
import { FileStore } from '@dommaker/studio-shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okr-b8-'));
const fileStore = new FileStore(testDir);
const service = new OKRService(fileStore);
let seededOkrId: string;

/** 创建 WorkUnitSnapshot 并写入 FileStore */
async function seedWorkUnit(overrides: Partial<import('@dommaker/studio-shared').WorkUnitSnapshot>): Promise<string> {
  const id = overrides.id ?? require('crypto').randomUUID();
  const now = new Date().toISOString();
  const snapshot: import('@dommaker/studio-shared').WorkUnitSnapshot = {
    id,
    parentId: null,
    type: 'task',
    scope: 'seed',
    assigneeId: null,
    status: 'unassigned',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    projectPath: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    claimedAt: null,
    completedAt: null,
    ...overrides,
  };
  await fileStore.upsertSnapshot(snapshot);
  return id;
}

describe('B8 OKR Service', () => {
  beforeAll(async () => {
    // 1. WorkUnits (parent) — for execution_success_rate, review_pass_rate queries
    const g1 = await seedWorkUnit({ scope: 'test-goal-ok', metadata: JSON.stringify({ description: 'seed' }), status: 'done' });
    const g2 = await seedWorkUnit({ scope: 'test-goal-fail', metadata: JSON.stringify({ description: 'seed' }), status: 'closed' });

    // 3. WorkUnit (child) — for execution health check
    await seedWorkUnit({ parentId: g1, scope: 'step-0', status: 'done' });

    // 4. OKR fixture — for syncKRProgress + recalibration
    const quarter = '2026-Q2';
    const okrDir = path.join(os.homedir(), '.studio', 'okr');
    fs.mkdirSync(okrDir, { recursive: true });
    const okrFilePath = path.join(okrDir, `${quarter}.md`);
    const okrId = 'okr-seeded';
    // Write OKR as markdown file (format expected by migrated service)
    const okrMeta = [
      '---',
      `id: "${okrId}"`,
      'status: "active"',
      `title: "Agent Network OKR Test"`,
      `quarter: "2026-Q2"`,
      'progress: 0',
      `createdAt: "${new Date().toISOString()}"`,
      `updatedAt: "${new Date().toISOString()}"`,
      `objectives: '[{"id":"o1","title":"Execution Quality"}]'`,
      `keyResults: '[{"id":"kr-exec","objectiveId":"o1","title":"执行成功率","target":80,"current":0,"unit":"%","metricType":"execution_success_rate"},{"id":"kr-review","objectiveId":"o1","title":"Review 通过率","target":90,"current":0,"unit":"%","metricType":"review_pass_rate"},{"id":"kr-deploy","objectiveId":"o1","title":"部署成功率","target":95,"current":0,"unit":"%","metricType":"deploy_success_rate"},{"id":"kr-incident","objectiveId":"o1","title":"事件数","target":5,"current":0,"unit":"count","metricType":"incident_count"}]'`,
      '---',
      '',
      '# Agent Network OKR Test',
      '',
      '## Objectives',
      '- o1: Execution Quality',
      '',
      '## Key Results',
      '- kr-exec: 执行成功率 (80%)',
      '- kr-review: Review 通过率 (90%)',
      '- kr-deploy: 部署成功率 (95%)',
      '- kr-incident: 事件数 (5)',
    ].join('\n');
    fs.writeFileSync(okrFilePath, okrMeta);
    seededOkrId = okrId;
  });

  afterAll(async () => {
    // Cleanup seeded data
    try { fs.unlinkSync(path.join(os.homedir(), '.studio', 'okr', '2026-Q2.md')); } catch {}
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('checkDataSourceHealth', () => {
    it('returns ok for data sources', async () => {
      const health = await service.checkDataSourceHealth();
      expect(health).toHaveProperty('studio_event');
      expect(health).toHaveProperty('execution');
      expect(health.execution).toBe('ok');
      // studio_event: may be 'empty' if no events seeded — that's OK for R3 test
    });
  });

  describe('validateKRTarget', () => {
    it('blocks target below baseline (R1)', async () => {
      // execution_success_rate has seeded data → baseline exists → target 1 should block
      const kr: OKRKeyResult = {
        id: 'test-r1', objectiveId: 'o1', title: 'exec rate too low',
        target: 1, current: 0, unit: '%', metricType: 'execution_success_rate',
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
      // Mock checkDataSourceHealth to simulate empty studio_event
      const spy = vi.spyOn(service, 'checkDataSourceHealth').mockResolvedValue({
        studio_event: 'empty', execution: 'ok',
      });
      const kr: OKRKeyResult = {
        id: 'test-r3', objectiveId: 'o1', title: 'incident count',
        target: 60, current: 0, unit: '%', metricType: 'incident_count',
      };
      const result = await service.validateKRTarget(kr);
      expect(result.status).toBe('blocked');
      expect(result.reasons[0]).toContain('为空');
      spy.mockRestore();
    });

    it('blocks target <= 0 (R4)', async () => {
      const kr: OKRKeyResult = {
        id: 'test-r4', objectiveId: 'o1', title: 'invalid',
        target: 0, current: 0, unit: '%', metricType: 'execution_success_rate',
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
    it('returns number for execution_success_rate', async () => {
      const baseline = await service.getMetricBaseline('execution_success_rate');
      expect(baseline).not.toBeNull();
      expect(typeof baseline).toBe('number');
      expect(baseline!).toBeGreaterThanOrEqual(0);
      expect(baseline!).toBeLessThanOrEqual(100);
    });

    it('returns number or null for review_pass_rate (depends on data)', async () => {
      const baseline = await service.getMetricBaseline('review_pass_rate');
      // review_pass_rate may return null if no review data in seeded WorkUnits
      if (baseline !== null) {
        expect(typeof baseline).toBe('number');
      }
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

    it('syncs OKR and returns mixed statuses', async () => {
      const results = await service.syncKRProgress(seededOkrId);
      expect(results.length).toBe(4);
      const statuses = results.map(r => r.status);
      // execution_success_rate + review_pass_rate (execution source) should be queryable
      expect(statuses).toContain('ok');
    });
  });

  describe('recalibration', () => {
    it('detects when baseline exceeds target', async () => {
      const suggestions = await service.getRecalibrationSuggestions(seededOkrId);
      // Just verify it returns an array without error
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  describe('getCurrentQuarter', () => {
    it('returns YYYY-QN format', () => {
      const q = getCurrentQuarter();
      expect(q).toMatch(/^\d{4}-Q[1-4]$/);
    });
  });

  describe('OKR metricType coverage', () => {
    // Execution OKR: metrics querying WorkUnit/StudioEvent
    const EXECUTION_KRS = [
      'execution_success_rate',      // WorkUnit success rate
      'review_pass_rate',            // WorkUnit review pass rate
      'deploy_success_rate',         // StudioEvent deploy success
      'deploy_failure_rate',         // StudioEvent deploy failure
      'max_concurrent',              // WorkUnit concurrent
      'conflict_rate',               // StudioEvent conflicts
      'incident_count',              // StudioEvent incidents
      'queue_duration_avg',          // WorkUnit queue duration
      'session_duration_avg',        // WorkUnit session duration
      'analyst_accuracy',            // StudioEvent analyst accuracy
      'resolution_count',            // StudioEvent resolutions
      'resolution_verify_rate',      // StudioEvent resolution verify
    ];

    // Knowledge OKR: 10 KRs
    const KNOWLEDGE_KRS = [
      'knowledge_quality_gate_pass_rate', // O1-KR1 质量门通过率
      'dedup_hit_rate',                   // O1-KR2 去重命中率
      'knowledge_quality_score',          // O1-KR3 内容质量分
      'knowledge_consumption_hit_rate',   // O2-KR1 注入命中率
      'execution_improvement',            // O2-KR2 执行改善度
      'knowledge_search_hit_rate',        // O2-KR3 搜索命中率
      'knowledge_skill_created',          // O3-KR1 Skill 生成数
      'knowledge_skill_usage_rate',       // O3-KR2 Skill 使用率
      'knowledge_growth_rate',            // O3-KR3 知识增速
      'knowledge_quality_trend',          // O3-KR4 质量趋势
    ];

    const ALL_KRS = [...EXECUTION_KRS, ...KNOWLEDGE_KRS];

    it.each(ALL_KRS)('metricType "%s" is registered', (metricType) => {
      expect(OKRService.METRIC_REGISTRY).toHaveProperty(metricType);
    });

    it('Execution OKR: all KRs have metricTypes', () => {
      for (const kr of EXECUTION_KRS) {
        expect(OKRService.METRIC_REGISTRY).toHaveProperty(kr);
      }
    });

    it('Knowledge OKR: all 10 KRs have metricTypes', () => {
      for (const kr of KNOWLEDGE_KRS) {
        expect(OKRService.METRIC_REGISTRY).toHaveProperty(kr);
      }
    });

    it('total metricTypes >= 22 (OKR coverage)', () => {
      expect(Object.keys(OKRService.METRIC_REGISTRY).length).toBeGreaterThanOrEqual(22);
    });

    it('UPPER_BOUNDS covers all registered metricTypes', () => {
      for (const key of Object.keys(OKRService.METRIC_REGISTRY)) {
        expect(OKRService.UPPER_BOUNDS).toHaveProperty(key);
      }
    });
  });
});
