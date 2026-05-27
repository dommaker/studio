// OKR Service - PMO 模块核心服务
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

export interface OKRObjective {
  id: string;
  title: string;
  description?: string;
}

export interface OKRKeyResult {
  id: string;
  objectiveId: string;
  title: string;
  target: number;
  current: number;
  unit: string;
  metricType?: string;     // 🆕 B8: 度量类型 e.g. "pipeline_duration_p90", "cache_hit_rate"
  queryParams?: Record<string, unknown>;  // 🆕 B8: 查询参数 e.g. { days: 7 }
}

export interface KRActual {
  value: number | null;
  status: 'ok' | 'no_data' | 'stale';
  lastUpdated: Date;
}

export interface CreateOKRInput {
  companyId: string;
  title: string;
  objectives: OKRObjective[];
  keyResults: OKRKeyResult[];
  quarter: string;
}

export interface UpdateOKRInput {
  title?: string;
  objectives?: OKRObjective[];
  keyResults?: OKRKeyResult[];
  status?: string;
}

/**
 * 🆕 AS-016: 获取当前季度
 */
export function getCurrentQuarter(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${year}-Q${quarter}`;
}

/**
 * OKR 服务
 */
export class OKRService {
  /**
   * 创建 OKR
   */
  async create(input: CreateOKRInput) {
    // 检查是否已存在相同 quarter 的 OKR
    const existing = await prisma.oKR.findUnique({
      where: {
        companyId_quarter: {
          companyId: input.companyId,
          quarter: input.quarter,
        },
      },
    });

    if (existing) {
      throw new Error(`OKR for quarter ${input.quarter} already exists`);
    }

    // 计算初始进度
    const progress = this.calculateProgress(input.keyResults);

    const okr = await prisma.oKR.create({
      data: {
        companyId: input.companyId,
        title: input.title,
        objectives: JSON.parse(JSON.stringify(input.objectives)),
        keyResults: JSON.parse(JSON.stringify(input.keyResults)),
        quarter: input.quarter,
        progress,
      },
    });

    logger.info({ okrId: okr.id, companyId: input.companyId }, 'OKR created');
    return okr;
  }

  /**
   * 获取 OKR 列表
   */
  async list(companyId: string, options?: { status?: string }) {
    const where: Record<string, unknown> = { companyId };
    if (options?.status) {
      where.status = options.status;
    }

    const okrs = await prisma.oKR.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { Execution: true },
        },
      },
    });

    return okrs.map(okr => ({
      ...okr,
      objectives: typeof okr.objectives === 'string' ? JSON.parse(okr.objectives) : okr.objectives,
      keyResults: typeof okr.keyResults === 'string' ? JSON.parse(okr.keyResults) : okr.keyResults,
      projectCount: okr._count.Execution,
    }));
  }

  /**
   * 获取 OKR 详情
   */
  async get(id: string) {
    const okr = await prisma.oKR.findUnique({
      where: { id },
      include: {
        Company: {
          select: { name: true, adminRoleIds: true },
        },
        Execution: {
          select: {
            id: true,
            workflowId: true,
            status: true,
            startTime: true,
            endTime: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!okr) {
      throw new Error('OKR not found');
    }

    return okr;
  }

  /**
   * 更新 OKR
   */
  async update(id: string, input: UpdateOKRInput) {
    const okr = await prisma.oKR.findUnique({
      where: { id },
    });

    if (!okr) {
      throw new Error('OKR not found');
    }

    // 如果更新了 keyResults，重新计算进度
    let progress = okr.progress;
    if (input.keyResults) {
      progress = this.calculateProgress(input.keyResults);
    }

    const updated = await prisma.oKR.update({
      where: { id },
      data: {
        title: input.title,
        objectives: input.objectives ? JSON.parse(JSON.stringify(input.objectives)) : undefined,
        keyResults: input.keyResults ? JSON.parse(JSON.stringify(input.keyResults)) : undefined,
        status: input.status,
        progress,
      },
    });

    logger.info({ okrId: id }, 'OKR updated');
    return updated;
  }

  /**
   * 删除 OKR
   */
  async delete(id: string) {
    // 检查是否有关联的项目
    const executionCount = await prisma.execution.count({
      where: { okrId: id },
    });

    if (executionCount > 0) {
      // 不删除关联项目，只是解除关联
      await prisma.execution.updateMany({
        where: { okrId: id },
        data: { okrId: null },
      });
    }

    await prisma.oKR.delete({
      where: { id },
    });

    logger.info({ okrId: id, executionCount }, 'OKR deleted');
    return { success: true, unlinkedProjects: executionCount };
  }

  /**
   * 计算进度
   */
  private calculateProgress(keyResults: OKRKeyResult[]): number {
    if (keyResults.length === 0) return 0;

    const totalProgress = keyResults.reduce((sum, kr) => {
      const progress = Math.min(kr.current / kr.target, 1);
      return sum + progress;
    }, 0);

    return totalProgress / keyResults.length;
  }

  /**
   * 检查权限（是否是管理员）
   */
  async checkPermission(roleId: string, companyId: string): Promise<boolean> {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { adminRoleIds: true },
    });

    if (!company) {
      return false;
    }

    return company.adminRoleIds.includes(roleId);
  }

  /**
   * 初始化管理员（将 CEO 加入 adminRoleIds）
   */
  async initAdmin(companyId: string) {
    // 查找 CEO 角色
    const ceoRole = await prisma.role.findFirst({
      where: {
        companyId,
        type: 'ceo',
      },
    });

    if (!ceoRole) {
      logger.warn({ companyId }, 'CEO role not found, cannot init admin');
      return;
    }

    // 更新公司管理员列表
    await prisma.company.update({
      where: { id: companyId },
      data: {
        adminRoleIds: JSON.stringify([ceoRole.id]),
      },
    });

    logger.info({ companyId, ceoRoleId: ceoRole.id }, 'Admin initialized');
  }

  /**
   * 🆕 AS-016: 获取公司当前季度默认 OKR
   */
  async getDefaultOKR(companyId: string): Promise<string | null> {
    const currentQuarter = getCurrentQuarter();
    
    const okr = await prisma.oKR.findFirst({
      where: { 
        companyId,
        quarter: currentQuarter,
        status: 'active',
      },
      orderBy: { createdAt: 'desc' },
    });
    
    return okr?.id || null;
  }

  /**
   * 🆕 AS-016: 创建默认 OKR（公司创建时）
   */
  async createDefaultOKR(companyId: string): Promise<{ id: string; title: string; quarter: string }> {
    const currentQuarter = getCurrentQuarter();
    
    const okr = await this.create({
      companyId,
      title: `${currentQuarter} 默认 OKR`,
      quarter: currentQuarter,
      objectives: [{ id: '1', title: '季度目标' }],
      keyResults: [],
    });
    
    logger.info({ companyId, okrId: okr.id, quarter: currentQuarter }, 'Default OKR created');
    return okr;
  }

  /**
   * 🆕 AS-016: 更新 OKR 进度（基于关联项目）
   */
  async updateProgress(okrId: string): Promise<number> {
    const projects = await prisma.project.findMany({
      where: { okrId },
      select: { progress: true, status: true },
    });

    if (projects.length === 0) {
      return 0;
    }

    // 只计算 active/in_review/completed 的项目
    const activeProjects = projects.filter(p =>
      ['active', 'in_review', 'completed'].includes(p.status)
    );

    if (activeProjects.length === 0) {
      return 0;
    }

    const avgProgress = activeProjects.reduce((sum, p) => sum + p.progress, 0) / activeProjects.length;

    await prisma.oKR.update({
      where: { id: okrId },
      data: { progress: Math.round(avgProgress) },
    });

    logger.info({ okrId, progress: Math.round(avgProgress), projectCount: activeProjects.length }, 'OKR progress updated');
    return Math.round(avgProgress);
  }

  // ── B8: OKR 驱动闭环 ──

  /**
   * 检查数据源可用性
   */
  async checkDataSourceHealth(): Promise<Record<string, 'ok' | 'empty'>> {
    const [pipelineRunCount, studioEventCount, goalCount, goalExecCount] = await Promise.all([
      prisma.pipelineRun.count(),
      prisma.studioEvent.count(),
      prisma.goal.count(),
      prisma.goalExecution.count(),
    ]);
    return {
      pipeline_run: pipelineRunCount > 0 ? 'ok' : 'empty',
      studio_event: studioEventCount > 0 ? 'ok' : 'empty',
      goal: goalCount > 0 ? 'ok' : 'empty',
      goal_execution: goalExecCount > 0 ? 'ok' : 'empty',
    };
  }

  /**
   * metricType → 数据源映射
   */
  private getDataSourceForMetric(metricType: string): string {
    const map: Record<string, string> = {
      pipeline_duration_p90: 'goal_execution',
      pipeline_duration_per_phase: 'pipeline_run',
      cache_hit_rate: 'pipeline_run',
      execution_success_rate: 'goal',
      review_pass_rate: 'goal',
      token_saving_ratio: 'studio_event',
    };
    return map[metricType] || 'unknown';
  }

  /**
   * 同步 KR 进度 — 从数据源查询实值
   */
  async syncKRProgress(okrId: string): Promise<KRActual[]> {
    const okr = await this.get(okrId);
    // Prisma SQLite auto-parses JSON strings — handle both cases
    const raw = okr.keyResults;
    const krs: OKRKeyResult[] = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const results: KRActual[] = [];

    const dsHealth = await this.checkDataSourceHealth();

    for (const kr of krs) {
      if (!kr.metricType) {
        results.push({ value: kr.current, status: 'ok', lastUpdated: new Date() });
        continue;
      }

      const requiredDS = this.getDataSourceForMetric(kr.metricType);
      if (dsHealth[requiredDS] === 'empty') {
        results.push({ value: null, status: 'no_data', lastUpdated: new Date() });
        continue;
      }

      const actual = await this.queryKRActual(kr);
      if (actual === null) {
        results.push({ value: null, status: 'no_data', lastUpdated: new Date() });
      } else {
        kr.current = actual;
        results.push({ value: actual, status: 'ok', lastUpdated: new Date() });
      }
    }

    // 只统计 status='ok' 的 KR 参与进度计算
    const okKRs = results.filter(r => r.status === 'ok' && r.value !== null);
    if (okKRs.length > 0) {
      const progress = this.calculateProgress(krs.filter(k =>
        results.some(r => r.status === 'ok' && r.value !== null)
      ));
      await prisma.oKR.update({
        where: { id: okrId },
        data: { keyResults: JSON.stringify(krs), progress },
      });
    }

    // 写 KRHistory 记录
    const now = new Date();
    await prisma.kRHistory.createMany({
      data: results.map(r => ({
        krId: krs.find(k => k.current === r.value || r.value === null)?.id || 'unknown',
        okrId,
        value: r.value ?? 0,
        status: r.status,
        timestamp: now,
      })),
    });

    logger.info({ okrId, results: results.map(r => r.status) }, 'KR progress synced');
    return results;
  }

  /**
   * 按 metricType 查询 KR 实际值
   */
  private async queryKRActual(kr: OKRKeyResult): Promise<number | null> {
    const days = (kr.queryParams?.days as number) || 7;

    switch (kr.metricType) {
      case 'pipeline_duration_p90':
        return this.queryPipelineDurationP90(days);
      case 'pipeline_duration_per_phase':
        return this.queryPipelineDurationPerPhase(kr.queryParams?.phase as string, days);
      case 'cache_hit_rate':
        return this.queryCacheHitRate(days);
      case 'execution_success_rate':
        return this.queryExecutionSuccessRate(days);
      case 'review_pass_rate':
        return this.queryReviewPassRate(days);
      case 'token_saving_ratio':
        return this.queryTokenSavingRatio(days);
      default:
        logger.warn({ metricType: kr.metricType }, 'Unknown metricType');
        return null;
    }
  }

  // ── 具体 metric 查询 ──

  /** 管线 e2e 耗时 p90 (从 GoalExecution wall clock) */
  private async queryPipelineDurationP90(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const executions = await prisma.goalExecution.findMany({
      where: {
        startedAt: { gte: since },
        completedAt: { not: null },
        status: 'succeeded',
      },
      select: { goalId: true, startedAt: true, completedAt: true },
    });

    if (executions.length === 0) return null;

    // 按 goalId 分组，算每个 Goal 的 wall clock
    const byGoal = new Map<string, { startedAt: Date; completedAt: Date }>();
    for (const e of executions) {
      const existing = byGoal.get(e.goalId);
      if (!existing) {
        byGoal.set(e.goalId, { startedAt: e.startedAt!, completedAt: e.completedAt! });
      } else {
        if (e.startedAt! < existing.startedAt) existing.startedAt = e.startedAt!;
        if (e.completedAt! > existing.completedAt) existing.completedAt = e.completedAt!;
      }
    }

    const durations = Array.from(byGoal.values())
      .map(g => g.completedAt.getTime() - g.startedAt.getTime())
      .filter(d => d > 1000)  // 排除 <1s 的异常值
      .sort((a, b) => a - b);

    if (durations.length === 0) return null;

    // p90
    const idx = Math.ceil(durations.length * 0.9) - 1;
    return Math.round(durations[Math.min(idx, durations.length - 1)] / 1000 / 60);
  }

  /** 管线单阶段耗时 */
  private async queryPipelineDurationPerPhase(phase?: string, days?: number): Promise<number | null> {
    const since = new Date(Date.now() - (days || 7) * 86400000);
    const where: Record<string, unknown> = {
      createdAt: { gte: since },
      phase: { not: 'full' },
    };
    if (phase) where.phase = phase;

    const result = await prisma.pipelineRun.aggregate({
      where,
      _avg: { durationMs: true },
    });

    return result._avg.durationMs ? Math.round(result._avg.durationMs / 1000 / 60) : null;
  }

  /** 缓存命中率 */
  private async queryCacheHitRate(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const result = await prisma.pipelineRun.aggregate({
      where: {
        createdAt: { gte: since },
        phase: { not: 'full' },
        inputTokens: { gt: 0 },
      },
      _sum: { cacheHitTokens: true, inputTokens: true },
    });

    const cacheHit = result._sum.cacheHitTokens || 0;
    const input = result._sum.inputTokens || 0;
    const total = cacheHit + input;
    if (total === 0) return null;
    // Claude: cache_read_input_tokens / (cache_read_input_tokens + input_tokens)
    return Math.round(cacheHit / total * 100);
  }

  /** 执行成功率 */
  private async queryExecutionSuccessRate(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const [total, succeeded] = await Promise.all([
      prisma.goal.count({ where: { createdAt: { gte: since }, status: { not: 'draft' } } }),
      prisma.goal.count({ where: { createdAt: { gte: since }, status: 'succeeded' } }),
    ]);

    if (total === 0) return null;
    return Math.round((succeeded / total) * 100);
  }

  /** 审查通过率 */
  private async queryReviewPassRate(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const goals = await prisma.goal.findMany({
      where: { createdAt: { gte: since }, status: { in: ['succeeded', 'failed'] } },
      select: { context: true },
    });

    const withReview = goals.filter(g => {
      try {
        const ctx = JSON.parse(g.context);
        return typeof ctx?.reviewScore === 'number';
      } catch { return false; }
    });

    if (withReview.length === 0) return null;

    const passed = withReview.filter(g => {
      const ctx = JSON.parse(g.context);
      return ctx.reviewScore >= 70;
    });

    return Math.round((passed.length / withReview.length) * 100);
  }

  /** Token 节省率 (pipeline vs window baseline) */
  private async queryTokenSavingRatio(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const pipeline = await prisma.pipelineRun.aggregate({
      where: { createdAt: { gte: since }, source: 'pipeline', phase: { not: 'full' } },
      _sum: { inputTokens: true },
    });
    const window = await prisma.pipelineRun.aggregate({
      where: { createdAt: { gte: since }, source: 'window', phase: { not: 'full' } },
      _sum: { inputTokens: true },
    });

    const pipelineTokens = pipeline._sum.inputTokens || 0;
    const windowTokens = window._sum.inputTokens || 0;
    if (windowTokens === 0) return null;
    return Math.round((1 - pipelineTokens / windowTokens) * 100);
  }

  // ── B8 Phase 1.5: KR 目标校验 ──

  /** 理论上限 */
  private static readonly UPPER_BOUNDS: Record<string, number> = {
    pipeline_duration_p90: Infinity,   // 越低越好，不设上限
    pipeline_duration_per_phase: Infinity,
    cache_hit_rate: 99.9,
    execution_success_rate: 100,
    review_pass_rate: 100,
    token_saving_ratio: 90,
  };

  /** 获取 metricType 的系统基线值 */
  async getMetricBaseline(metricType: string): Promise<number | null> {
    const kr: OKRKeyResult = {
      id: '_baseline_', objectiveId: '', title: '', target: 0, current: 0, unit: '',
      metricType, queryParams: { days: 7 },
    };
    return this.queryKRActual(kr);
  }

  /** 校验 KR target 是否合理 */
  async validateKRTarget(kr: OKRKeyResult): Promise<{
    status: 'pass' | 'warning' | 'blocked';
    reasons: string[];
    baseline: number | null;
    upperBound: number;
  }> {
    const reasons: string[] = [];
    let status: 'pass' | 'warning' | 'blocked' = 'pass';

    // R4: target > 0
    if (kr.target <= 0) {
      reasons.push('目标值必须大于 0');
      status = 'blocked';
      return { status, reasons, baseline: null, upperBound: 0 };
    }

    const upperBound = OKRService.UPPER_BOUNDS[kr.metricType || ''] || 100;

    // 没有 metricType → 手动更新，不校验
    if (!kr.metricType) {
      return { status: 'pass', reasons: ['手动更新，不校验'], baseline: null, upperBound };
    }

    // R3: 数据源可用性
    const dsHealth = await this.checkDataSourceHealth();
    const ds = this.getDataSourceForMetric(kr.metricType);
    if (ds && dsHealth[ds] === 'empty') {
      reasons.push(`数据源 ${ds} 为空，不能自动度量。选"手动更新"或等数据就绪`);
      status = 'blocked';
      return { status, reasons, baseline: null, upperBound };
    }

    // 查基线
    const baseline = await this.getMetricBaseline(kr.metricType);

    if (baseline === null) {
      reasons.push('暂时无法获取基线数据');
      return { status: 'warning', reasons, baseline: null, upperBound };
    }

    // R1: target 不能低于 baseline
    if (kr.target < baseline) {
      const suggestedMin = Math.ceil(baseline * 1.05);
      reasons.push(`目标 (${kr.target}${kr.unit}) 低于当前水平 (${baseline}${kr.unit})。建议 >= ${suggestedMin}${kr.unit}`);
      status = 'blocked';
    }

    // R2: target 远高于 baseline → 警告分阶段
    if (baseline > 0 && kr.target > baseline * 3) {
      const stage1 = Math.ceil(baseline * 2);
      reasons.push(`目标 (${kr.target}${kr.unit}) 距当前水平 (${baseline}${kr.unit}) 差距过大，建议分阶段。第一阶段: ${stage1}${kr.unit}`);
      if (status !== 'blocked') status = 'warning';
    }

    // R2b: target 超过理论上限 95%
    if (upperBound !== Infinity && kr.target > upperBound * 0.95) {
      reasons.push(`目标 (${kr.target}${kr.unit}) 接近理论上限 (${upperBound}${kr.unit})，可能不可实现`);
      if (status !== 'blocked') status = 'warning';
    }

    return { status, reasons, baseline, upperBound };
  }

  /** Auditor 重校准: baseline 已超 target → 建议上调 */
  async getRecalibrationSuggestions(okrId: string): Promise<string[]> {
    const suggestions: string[] = [];
    try {
      const okr = await this.get(okrId);
      const raw = okr.keyResults;
      const krs: OKRKeyResult[] = typeof raw === 'string' ? JSON.parse(raw) : raw;

      for (const kr of krs) {
        if (!kr.metricType || kr.target <= 0) continue;

        const baseline = await this.getMetricBaseline(kr.metricType);
        if (baseline === null) continue;

        if (baseline > kr.target * 1.05) {
          const suggested = Math.ceil(baseline * 1.02);
          suggestions.push(
            `KR "${kr.title}": 当前实际 ${baseline}${kr.unit} 已超过目标 ${kr.target}${kr.unit}。建议上调 target 至 >= ${suggested}${kr.unit}`
          );
        }
      }
    } catch (e) {
      logger.warn({ error: String(e) }, '[OKR] Recalibration failed');
    }
    return suggestions;
  }
}

export const okrService = new OKRService();