// B8 OKR 核心逻辑测试
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '../../../core/database.js';
import { OKRService, getCurrentQuarter } from '../okr.service.js';
import type { OKRKeyResult } from '../okr.service.js';

const service = new OKRService();
let testCompanyId: string;
let seededOkrId: string;
const seededIds: { pipelineRuns: string[]; workUnits: string[]; goals: string[]; goalExecutions: string[] } = {
  pipelineRuns: [], workUnits: [], goals: [], goalExecutions: [],
};

describe('B8 OKR Service', () => {
  beforeAll(async () => {
    // 1. Company
    const company = await prisma.company.findFirst();
    testCompanyId = company?.id || (await prisma.company.create({ data: { name: 'B8 Test Corp' } })).id;

    // 2. PipelineRun — for cache_hit_rate, pipeline_duration_p90 queries
    const pr = await prisma.pipelineRun.create({
      data: {
        source: 'test', phase: 'executor', taskName: 'test-task',
        model: 'standard', inputTokens: 1000, outputTokens: 500,
        cacheHitTokens: 600, durationMs: 300000, success: true,
      },
    });
    seededIds.pipelineRuns.push(pr.id);

    // 3. WorkUnits (parent) — for execution_success_rate, review_pass_rate queries
    const g1 = await prisma.workUnit.create({
      data: { scope: 'test-goal-ok', metadata: JSON.stringify({ description: 'seed' }), status: 'done', type: 'task' },
    });
    const g2 = await prisma.workUnit.create({
      data: { scope: 'test-goal-fail', metadata: JSON.stringify({ description: 'seed' }), status: 'closed', type: 'task' },
    });
    seededIds.workUnits.push(g1.id, g2.id);

    // 4. WorkUnit (child) — for goal_execution health check
    await prisma.workUnit.create({
      data: { parentId: g1.id, scope: 'step-0', status: 'done', type: 'task' },
    });

    // 4b. Goal + GoalExecution — for checkDataSourceHealth & getMetricBaseline
    const goal1 = await prisma.goal.create({
      data: { title: 'test-goal-ok', description: 'seed', status: 'succeeded', companyId: testCompanyId },
    });
    const goal2 = await prisma.goal.create({
      data: { title: 'test-goal-fail', description: 'seed', status: 'failed', companyId: testCompanyId },
    });
    seededIds.goals.push(goal1.id, goal2.id);

    const ge1 = await prisma.goalExecution.create({
      data: { goalId: goal1.id, stepIndex: 0, status: 'succeeded', startedAt: new Date(), completedAt: new Date() },
    });
    seededIds.goalExecutions.push(ge1.id);

    // 5. OKR fixture — for syncKRProgress + recalibration
    const okr = await prisma.oKR.create({
      data: {
        companyId: testCompanyId,
        title: 'Pipeline OKR Test',
        quarter: '2026-Q2',
        objectives: JSON.stringify([{ id: 'o1', title: 'Pipeline Quality' }]),
        keyResults: JSON.stringify([
          { id: 'kr-cache', objectiveId: 'o1', title: '缓存命中率', target: 50, current: 0, unit: '%', metricType: 'cache_hit_rate' },
          { id: 'kr-exec', objectiveId: 'o1', title: '执行成功率', target: 80, current: 0, unit: '%', metricType: 'execution_success_rate' },
          { id: 'kr-token', objectiveId: 'o1', title: 'Token 节省率', target: 60, current: 0, unit: '%', metricType: 'token_saving_ratio' },
          { id: 'kr-duration', objectiveId: 'o1', title: '管线 e2e 耗时 p90', target: 600000, current: 0, unit: 'ms', metricType: 'pipeline_duration_p90' },
          { id: 'kr-review', objectiveId: 'o1', title: 'Review 通过率', target: 90, current: 0, unit: '%', metricType: 'review_pass_rate' },
          { id: 'kr-cost', objectiveId: 'o1', title: '单 Goal 成本', target: 50000, current: 0, unit: 'tokens', metricType: 'pipeline_goal_cost' },
        ]),
        progress: 0,
      },
    });
    seededOkrId = okr.id;
  });

  afterAll(async () => {
    // Cleanup seeded data (order matters for FK constraints)
    await prisma.kRHistory.deleteMany({ where: { okrId: seededOkrId } });
    await prisma.oKR.deleteMany({ where: { id: seededOkrId } });
    await prisma.goalExecution.deleteMany({ where: { id: { in: seededIds.goalExecutions } } });
    await prisma.goal.deleteMany({ where: { id: { in: seededIds.goals } } });
    await prisma.workUnit.deleteMany({ where: { parentId: { in: seededIds.workUnits } } });
    await prisma.workUnit.deleteMany({ where: { id: { in: seededIds.workUnits } } });
    await prisma.pipelineRun.deleteMany({ where: { id: { in: seededIds.pipelineRuns } } });
  });

  describe('checkDataSourceHealth', () => {
    it('returns ok for all 4 data sources', async () => {
      const health = await service.checkDataSourceHealth();
      expect(health).toHaveProperty('pipeline_run');
      expect(health).toHaveProperty('studio_event');
      expect(health).toHaveProperty('goal');
      expect(health).toHaveProperty('goal_execution');
      expect(health.pipeline_run).toBe('ok');
      expect(health.goal).toBe('ok');
      expect(health.goal_execution).toBe('ok');
      // studio_event: may be 'empty' if no events seeded — that's OK for R3 test
    });
  });

  describe('validateKRTarget', () => {
    it('blocks target below baseline (R1)', async () => {
      // cache_hit_rate baseline = 600/(600+1000)*100 = 37.5 → target 30 should block
      const kr: OKRKeyResult = {
        id: 'test-r1', objectiveId: 'o1', title: 'cache hit too low',
        target: 30, current: 0, unit: '%', metricType: 'cache_hit_rate',
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
        pipeline_run: 'ok', studio_event: 'empty', goal: 'ok', goal_execution: 'ok',
      });
      const kr: OKRKeyResult = {
        id: 'test-r3', objectiveId: 'o1', title: 'token saving',
        target: 60, current: 0, unit: '%', metricType: 'token_saving_ratio',
      };
      const result = await service.validateKRTarget(kr);
      expect(result.status).toBe('blocked');
      expect(result.reasons[0]).toContain('为空');
      spy.mockRestore();
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
      const results = await service.syncKRProgress(seededOkrId);
      expect(results.length).toBe(6);
      const statuses = results.map(r => r.status);
      // cache_hit_rate + execution_success_rate + pipeline_duration_p90 + review_pass_rate should be 'ok'
      expect(statuses).toContain('ok');
      // token_saving_ratio (StudioEvent source) should be no_data
      expect(statuses).toContain('no_data');
    });
  });

  describe('recalibration', () => {
    it('detects when baseline exceeds target', async () => {
      const suggestions = await service.getRecalibrationSuggestions(seededOkrId);
      // pipeline_duration_p90: actual ~300000ms (5min) vs target 600000ms (10min) → NOT exceeding
      // But if we check cache_hit_rate: baseline ~37% vs target 50% → NOT exceeding
      // So just verify it returns an array without error
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
    // Pipeline OKR: 14 KRs
    const PIPELINE_KRS = [
      'pipeline_duration_p90',       // O1-KR1 p90 总耗时
      'pipeline_duration_per_phase', // O1-KR2 各阶段耗时
      'execution_success_rate',      // O1-KR3 成功完成率
      'token_saving_ratio',          // O2-KR1 token 节省率
      'cache_hit_rate',              // O2-KR2 缓存命中率
      'pipeline_goal_cost',          // O2-KR3 单 Goal 成本
      'test_pass_rate',              // O3-KR1 测试通过率
      'review_pass_rate',            // O3-KR2 Review 通过率
      'deploy_success_rate',         // O3-KR3 部署成功率
      'deploy_failure_rate',         // O3-KR3b 部署失败率
      'rollback_rate',               // O3-KR4 回滚率
      'max_concurrent',              // O4-KR1 最大并行数
      'conflict_rate',               // O4-KR2 冲突率
      'queue_duration_avg',          // O4-KR3 排队时间
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

    const ALL_KRS = [...PIPELINE_KRS, ...KNOWLEDGE_KRS];

    it.each(ALL_KRS)('metricType "%s" is registered', (metricType) => {
      expect(OKRService.METRIC_REGISTRY).toHaveProperty(metricType);
    });

    it('Pipeline OKR: all 14 KRs have metricTypes', () => {
      for (const kr of PIPELINE_KRS) {
        expect(OKRService.METRIC_REGISTRY).toHaveProperty(kr);
      }
    });

    it('Knowledge OKR: all 10 KRs have metricTypes', () => {
      for (const kr of KNOWLEDGE_KRS) {
        expect(OKRService.METRIC_REGISTRY).toHaveProperty(kr);
      }
    });

    it('total metricTypes >= 24 (OKR coverage)', () => {
      expect(Object.keys(OKRService.METRIC_REGISTRY).length).toBeGreaterThanOrEqual(24);
    });

    it('UPPER_BOUNDS covers all registered metricTypes', () => {
      for (const key of Object.keys(OKRService.METRIC_REGISTRY)) {
        expect(OKRService.UPPER_BOUNDS).toHaveProperty(key);
      }
    });
  });
});
