// OKR Service - PMO 模块核心服务
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
    const [pipelineRunCount, studioEventCount, workUnitCount] = await Promise.all([
      prisma.pipelineRun.count(),
      prisma.studioEvent.count(),
      prisma.workUnit.count(),
    ]);
    return {
      pipeline_run: pipelineRunCount > 0 ? 'ok' : 'empty',
      studio_event: studioEventCount > 0 ? 'ok' : 'empty',
      goal: workUnitCount > 0 ? 'ok' : 'empty',
      goal_execution: workUnitCount > 0 ? 'ok' : 'empty',
    };
  }

  /**
   * metricType → 数据源映射
   */
  private getDataSourceForMetric(metricType: string): string {
    const entry = OKRService.METRIC_REGISTRY[metricType];
    return entry?.dataSource || 'unknown';
  }

  /**
   * Metric type registry — single source of truth for all metric types.
   * Each entry defines: dataSource, query function, description.
   */
  static readonly METRIC_REGISTRY: Record<string, {
    dataSource: string;
    query: (okr: OKRService, days: number, params?: Record<string, unknown>) => Promise<number | null>;
    description: string;
  }> = {
    pipeline_duration_p90: {
      dataSource: 'goal_execution',
      query: (okr, days) => okr.queryPipelineDurationP90(days),
      description: '管线 e2e 耗时 p90',
    },
    pipeline_duration_per_phase: {
      dataSource: 'execution_run',
      query: (okr, days, params) => okr.queryPipelineDurationPerPhase(params?.phase as string, days),
      description: '单阶段耗时',
    },
    cache_hit_rate: {
      dataSource: 'execution_run',
      query: (okr, days) => okr.queryCacheHitRate(days),
      description: '缓存命中率',
    },
    execution_success_rate: {
      dataSource: 'goal',
      query: (okr, days) => okr.queryExecutionSuccessRate(days),
      description: '执行成功率',
    },
    review_pass_rate: {
      dataSource: 'goal',
      query: (okr, days) => okr.queryReviewPassRate(days),
      description: '审查通过率',
    },
    token_saving_ratio: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryTokenSavingRatio(days),
      description: 'Token 节省比',
    },
    knowledge_entry_count: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryKnowledgeEntryCount(days),
      description: '知识条目总数',
    },
    knowledge_consumption_hit_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryKnowledgeConsumptionHitRate(days),
      description: '知识消费命中率',
    },
    resolution_count: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryResolutionCount(days),
      description: 'Resolution 总数',
    },
    resolution_verify_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryResolutionVerifyRate(days),
      description: 'Resolution 验证率',
    },
    incident_count: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryIncidentCount(days),
      description: '事件数',
    },
    deploy_success_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryDeploySuccessRate(days),
      description: '部署成功率',
    },
    deploy_failure_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryDeployFailureRate(days),
      description: '部署失败率',
    },
    analyst_accuracy: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryAnalystAccuracy(days),
      description: 'Analyst 预测准确率',
    },
    behavior_feedback_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryBehaviorFeedbackRate(days),
      description: '行为反馈率',
    },
    pipeline_cost_tokens: {
      dataSource: 'execution_run',
      query: (okr, days) => okr.queryPipelineCostTokens(days),
      description: '管线 Token 总消耗',
    },
    session_duration_avg: {
      dataSource: 'goal_execution',
      query: (okr, days) => okr.querySessionDurationAvg(days),
      description: '平均会话时长',
    },
    // ── Batch A: OKR metricTypes (data source exists) ──
    test_pass_rate: {
      dataSource: 'execution_run',
      query: (okr, days) => okr.queryTestPassRate(days),
      description: '测试通过率 (PipelineRun.testPassed)',
    },
    pipeline_goal_cost: {
      dataSource: 'execution_run',
      query: (okr, days) => okr.queryPipelineGoalCost(days),
      description: '单 Goal 平均 Token 成本',
    },
    queue_duration_avg: {
      dataSource: 'goal',
      query: (okr, days) => okr.queryQueueDurationAvg(days),
      description: '平均排队时间 (WorkUnit.createdAt → child.claimedAt)',
    },
    knowledge_quality_gate_pass_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryKnowledgeQualityGatePassRate(days),
      description: '知识质量门通过率 (extractFromExecution success)',
    },
    knowledge_quality_score: {
      dataSource: 'knowledge_service',
      query: (okr, days) => okr.queryKnowledgeQualityScore(days),
      description: '知识内容质量分 (D2 audit score)',
    },
    knowledge_search_hit_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryKnowledgeSearchHitRate(days),
      description: '知识搜索命中率',
    },
    knowledge_quality_trend: {
      dataSource: 'knowledge_service',
      query: (okr, days) => okr.queryKnowledgeQualityTrend(days),
      description: '知识质量趋势 (D2 score point-in-time)',
    },
    // ── Batch B: OKR metricTypes (need data source wiring) ──
    dedup_hit_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryDedupHitRate(days),
      description: '去重命中率 (qualityGate skip)',
    },
    knowledge_skill_created: {
      dataSource: 'file_system',
      query: (okr, days) => okr.querySkillCreated(days),
      description: 'Skill 生成数 (.studio/knowledge/skills/)',
    },
    knowledge_skill_usage_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.querySkillUsageRate(days),
      description: 'Skill 使用率 (skill_used events / published skill count on disk)',
    },
    knowledge_growth_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryKnowledgeGrowthRate(days),
      description: '知识增速 (new entries per period)',
    },
    execution_improvement: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryExecutionImprovement(days),
      description: '执行改善度 (recordOutcome before/after)',
    },
    // ── Batch C: OKR metricTypes (need infrastructure) ──
    rollback_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryRollbackRate(days),
      description: '回滚率 (N/A — 系统无 rollback 机制)',
    },
    max_concurrent: {
      dataSource: 'goal',
      query: (okr, days) => okr.queryMaxConcurrent(days),
      description: '最大并行数 (concurrent executing goals)',
    },
    conflict_rate: {
      dataSource: 'studio_event',
      query: (okr, days) => okr.queryConflictRate(days),
      description: '冲突率 (scheduler conflict events)',
    },
  };

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
    const entry = kr.metricType ? OKRService.METRIC_REGISTRY[kr.metricType] : null;

    if (!entry) {
      if (kr.metricType) logger.warn({ metricType: kr.metricType }, 'Unknown metricType');
      return null;
    }

    return entry.query(this, days, kr.queryParams);
  }

  // ── 具体 metric 查询 ──

  /** 管线 e2e 耗时 p90 — 优先 PipelineRun phase='full', 回退 GoalExecution wall clock */
  private async queryPipelineDurationP90(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);

    // Source 1: PipelineRun phase='full' (goal-level summary, most reliable)
    const fullRuns = await prisma.pipelineRun.findMany({
      where: {
        phase: 'full',
        createdAt: { gte: since },
        durationMs: { gt: 1000 },
      },
      select: { durationMs: true, goalId: true },
    });

    if (fullRuns.length > 0) {
      const durations = fullRuns.map(r => r.durationMs).sort((a, b) => a - b);
      const idx = Math.ceil(durations.length * 0.9) - 1;
      return Math.round(durations[Math.min(idx, durations.length - 1)] / 1000 / 60);
    }

    // Source 2: PipelineRun step-level, aggregate by goalId
    const stepRuns = await prisma.pipelineRun.findMany({
      where: {
        createdAt: { gte: since },
        goalId: { not: null },
        phase: { not: 'full' },
      },
      select: { goalId: true, durationMs: true },
    });

    if (stepRuns.length > 0) {
      const byGoal = new Map<string, number>();
      for (const r of stepRuns) {
        byGoal.set(r.goalId!, (byGoal.get(r.goalId!) || 0) + r.durationMs);
      }
      const durations = Array.from(byGoal.values()).filter(d => d > 1000).sort((a, b) => a - b);
      if (durations.length > 0) {
        const idx = Math.ceil(durations.length * 0.9) - 1;
        return Math.round(durations[Math.min(idx, durations.length - 1)] / 1000 / 60);
      }
    }

    // Source 3: WorkUnit wall clock (legacy fallback)
    const executions = await prisma.workUnit.findMany({
      where: {
        claimedAt: { gte: since },
        completedAt: { not: null },
        status: 'done',
      },
      select: { parentId: true, claimedAt: true, completedAt: true },
    });

    if (executions.length === 0) return null;

    const byParentExec = new Map<string, { claimedAt: Date; completedAt: Date }>();
    for (const e of executions) {
      const existing = byParentExec.get(e.parentId!);
      if (!existing) {
        byParentExec.set(e.parentId!, { claimedAt: e.claimedAt!, completedAt: e.completedAt! });
      } else {
        if (e.claimedAt! < existing.claimedAt) existing.claimedAt = e.claimedAt!;
        if (e.completedAt! > existing.completedAt) existing.completedAt = e.completedAt!;
      }
    }

    const durations = Array.from(byParentExec.values())
      .map(g => g.completedAt.getTime() - g.claimedAt.getTime())
      .filter(d => d > 1000)
      .sort((a, b) => a - b);

    if (durations.length === 0) return null;

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
      prisma.workUnit.count({ where: { createdAt: { gte: since }, status: { not: 'unassigned' } } }),
      prisma.workUnit.count({ where: { createdAt: { gte: since }, status: 'done' } }),
    ]);

    if (total === 0) return null;
    return Math.round((succeeded / total) * 100);
  }

  /** 审查通过率 */
  private async queryReviewPassRate(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const workUnits = await prisma.workUnit.findMany({
      where: { createdAt: { gte: since }, status: { in: ['done', 'closed'] } },
      select: { metadata: true },
    });

    const withReview = workUnits.filter(w => {
      try {
        const md = JSON.parse(w.metadata!);
        return typeof md?.reviewScore === 'number';
      } catch { return false; }
    });

    if (withReview.length === 0) return null;

    const passed = withReview.filter(w => {
      const md = JSON.parse(w.metadata!);
      return md.reviewScore >= 70;
    });

    return Math.round((passed.length / withReview.length) * 100);
  }

  /** Token 节省率 (pipeline vs window baseline) */
  private async queryTokenSavingRatio(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const pipeline = await prisma.pipelineRun.aggregate({
      where: { createdAt: { gte: since }, source: 'execution', phase: { not: 'full' } },
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

  // ── Extended metric queries (registry) ──

  private async queryKnowledgeEntryCount(_days: number): Promise<number | null> {
    try {
      const { knowledgeService } = await import('../knowledge/knowledge-service.js');
      const stats = knowledgeService.getStats();
      return stats.total || 0;
    } catch { return null; }
  }

  private async queryKnowledgeConsumptionHitRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const [injected, consumed] = await Promise.all([
        prisma.studioEvent.count({ where: { type: 'knowledge:injected', timestamp: { gte: since } } }),
        prisma.studioEvent.count({ where: { type: 'knowledge:consumption', timestamp: { gte: since } } }),
      ]);
      if (injected === 0) return null;
      return Math.round((consumed / injected) * 100);
    } catch { return null; }
  }

  private async queryResolutionCount(_days: number): Promise<number | null> {
    try {
      return await prisma.resolution.count();
    } catch { return null; }
  }

  private async queryResolutionVerifyRate(_days: number): Promise<number | null> {
    try {
      const total = await prisma.resolution.count();
      if (total === 0) return null;
      const verified = await prisma.resolution.count({ where: { status: 'verified' } });
      return Math.round((verified / total) * 100);
    } catch { return null; }
  }

  private async queryIncidentCount(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      return await prisma.incident.count({ where: { detectedAt: { gte: since } } });
    } catch { return null; }
  }

  private async queryDeploySuccessRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await prisma.studioEvent.findMany({
        where: { type: 'deploy.completed', timestamp: { gte: since } },
        select: { payload: true },
      });
      if (events.length === 0) return null;
      const success = events.filter(e => {
        try {
          const p = JSON.parse(e.payload);
          // T3: top-level success (current format) with backward compat for result.success
          return typeof p.success === 'boolean' ? p.success : p.result?.success;
        } catch { return false; }
      }).length;
      return Math.round((success / events.length) * 100);
    } catch { return null; }
  }

  /** T3: deploy_failure_rate — count of deploy.completed where success=false / total */
  private async queryDeployFailureRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await prisma.studioEvent.findMany({
        where: { type: 'deploy.completed', timestamp: { gte: since } },
        select: { payload: true },
      });
      if (events.length === 0) return null;
      const failures = events.filter(e => {
        try {
          const p = JSON.parse(e.payload);
          const success = typeof p.success === 'boolean' ? p.success : p.result?.success;
          return success === false;
        } catch { return false; }
      }).length;
      return Math.round((failures / events.length) * 100);
    } catch { return null; }
  }

  private async queryAnalystAccuracy(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await prisma.studioEvent.findMany({
        where: { type: 'knowledge:analyst_accuracy', timestamp: { gte: since } },
        select: { payload: true },
      });
      if (events.length === 0) return null;
      const accurate = events.filter(e => {
        try { return JSON.parse(e.payload).accurate; } catch { return false; }
      }).length;
      return Math.round((accurate / events.length) * 100);
    } catch { return null; }
  }

  private async queryBehaviorFeedbackRate(_days: number): Promise<number | null> {
    try {
      const total = await prisma.userBehaviorProfile.count();
      if (total === 0) return null;
      const feedback = await prisma.userBehaviorProfile.count({
        where: { status: { in: ['confirmed', 'rejected', 'applied'] } },
      });
      return Math.round((feedback / total) * 100);
    } catch { return null; }
  }

  private async queryPipelineCostTokens(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const agg = await prisma.pipelineRun.aggregate({
        where: { createdAt: { gte: since }, source: 'execution' },
        _sum: { inputTokens: true, outputTokens: true },
      });
      return (agg._sum.inputTokens || 0) + (agg._sum.outputTokens || 0);
    } catch { return null; }
  }

  private async querySessionDurationAvg(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const execs = await prisma.workUnit.findMany({
        where: { claimedAt: { gte: since }, completedAt: { not: null }, status: 'done' },
        select: { claimedAt: true, completedAt: true },
      });
      if (execs.length === 0) return null;
      const totalMs = execs.reduce((sum, e) =>
        sum + (e.completedAt!.getTime() - e.claimedAt!.getTime()), 0);
      return Math.round(totalMs / execs.length / 1000 / 60); // minutes
    } catch { return null; }
  }

  // ── Batch A: OKR metricType queries (data source exists) ──

  /** Pipeline O3-KR1: 测试通过率 */
  private async queryTestPassRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const [total, passed] = await Promise.all([
        prisma.pipelineRun.count({ where: { createdAt: { gte: since }, testPassed: { not: null } } }),
        prisma.pipelineRun.count({ where: { createdAt: { gte: since }, testPassed: true } }),
      ]);
      if (total === 0) return null;
      return Math.round((passed / total) * 100);
    } catch { return null; }
  }

  /** Pipeline O2-KR3: 单 Goal 成本 (USD from StudioEvent, fallback to tokens) */
  private async queryPipelineGoalCost(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      // Try StudioEvent costUsd first
      const costEvents = await prisma.studioEvent.findMany({
        where: { timestamp: { gte: since }, type: 'execution_run', costUsd: { gt: 0 } },
        select: { executionId: true, costUsd: true },
      });
      if (costEvents.length > 0) {
        const byGoal = new Map<string, number>();
        for (const e of costEvents) {
          const key = e.executionId || 'unknown';
          byGoal.set(key, (byGoal.get(key) || 0) + (e.costUsd || 0));
        }
        if (byGoal.size > 0) {
          const total = Array.from(byGoal.values()).reduce((s, v) => s + v, 0);
          return Math.round((total / byGoal.size) * 1000) / 1000;
        }
      }
      // Fallback: token-based proxy
      const runs = await prisma.pipelineRun.findMany({
        where: { createdAt: { gte: since }, source: 'execution', phase: { not: 'full' } },
        select: { goalId: true, inputTokens: true, outputTokens: true },
      });
      if (runs.length === 0) return null;
      const byGoal = new Map<string, number>();
      for (const r of runs) {
        const key = r.goalId || 'unknown';
        byGoal.set(key, (byGoal.get(key) || 0) + r.inputTokens + r.outputTokens);
      }
      if (byGoal.size === 0) return null;
      const totalTokens = Array.from(byGoal.values()).reduce((s, v) => s + v, 0);
      return Math.round(totalTokens / byGoal.size);
    } catch { return null; }
  }

  /** Pipeline O4-KR3: 排队时间 (WorkUnit.createdAt → child.claimedAt) */
  private async queryQueueDurationAvg(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const childUnits = await prisma.workUnit.findMany({
        where: { createdAt: { gte: since }, parentId: { not: null } },
        select: { parentId: true, createdAt: true, claimedAt: true },
      });
      if (childUnits.length === 0) return null;

      // Queue time = child.createdAt - parent.createdAt (approx: child.createdAt - child.claimedAt + wait)
      // Simpler: child.claimedAt - child.createdAt (time from creation to claim = queue time)
      const waits: number[] = [];
      for (const w of childUnits) {
        if (w.claimedAt) {
          waits.push(w.claimedAt.getTime() - w.createdAt.getTime());
        }
      }
      if (waits.length === 0) return null;
      return Math.round(waits.reduce((s, w) => s + w, 0) / waits.length / 1000 / 60); // minutes
    } catch { return null; }
  }

  /** Knowledge O1-KR1: 质量门通过率 (extractFromExecution success rate) */
  private async queryKnowledgeQualityGatePassRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await prisma.studioEvent.findMany({
        where: { type: 'extractFromExecution', timestamp: { gte: since } },
        select: { payload: true },
      });
      if (events.length === 0) return null;
      const success = events.filter(e => {
        try { return JSON.parse(e.payload).success; } catch { return false; }
      }).length;
      return Math.round((success / events.length) * 100);
    } catch { return null; }
  }

  /** Knowledge O1-KR3: 内容质量分 */
  private async queryKnowledgeQualityScore(_days: number): Promise<number | null> {
    try {
      const { knowledgeService } = await import('../knowledge/knowledge-service.js');
      const metrics = await knowledgeService.getFlywheelMetrics();
      return metrics.quality ?? null;
    } catch { return null; }
  }

  /** Knowledge O2-KR3: 搜索命中率 */
  private async queryKnowledgeSearchHitRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const [searches, hits] = await Promise.all([
        prisma.studioEvent.count({ where: { type: 'knowledge:search', timestamp: { gte: since } } }),
        prisma.studioEvent.count({ where: { type: 'knowledge:search_hit', timestamp: { gte: since } } }),
      ]);
      if (searches === 0) return null;
      return Math.round((hits / searches) * 100);
    } catch { return null; }
  }

  /** Knowledge O3-KR4: 质量趋势 (current D2 score, trend via KRHistory) */
  private async queryKnowledgeQualityTrend(days: number): Promise<number | null> {
    try {
      const { knowledgeService } = await import('../knowledge/knowledge-service.js');
      const metrics = await knowledgeService.getFlywheelMetrics();
      return metrics.quality ?? null;
    } catch { return null; }
  }

  // ── Batch B: queries (data source needs wiring) ──

  /** Knowledge O1-KR2: 去重命中率 */
  private async queryDedupHitRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await prisma.studioEvent.findMany({
        where: { type: 'knowledge:quality_gate', timestamp: { gte: since } },
        select: { payload: true },
      });
      if (events.length === 0) return null;
      const skipped = events.filter(e => {
        try { return JSON.parse(e.payload).skipped; } catch { return false; }
      }).length;
      return Math.round((skipped / events.length) * 100);
    } catch { return null; }
  }

  /** Knowledge O3-KR1: Skill 生成数 */
  private async querySkillCreated(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await prisma.studioEvent.count({
        where: { type: 'knowledge:skill_created', timestamp: { gte: since } },
      });
      return events || 0;
    } catch { return null; }
  }

  /** Knowledge O3-KR2: Skill 使用率 (used / total published on disk) */
  private async querySkillUsageRate(days: number): Promise<number | null> {
    try {
      // B59-003: count published skills from disk (no StudioEvent needed)
      const skillsDir = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');
      let total = 0;
      try {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) {
            total++;
          }
        }
      } catch { /* skills dir may not exist */ }
      if (total === 0) return null;

      const since = new Date(Date.now() - days * 86400000);
      const used = await prisma.studioEvent.count({ where: { type: 'knowledge:skill_used', timestamp: { gte: since } } });
      return Math.round((used / total) * 100);
    } catch { return null; }
  }

  /** Knowledge O3-KR3: 知识增速 */
  private async queryKnowledgeGrowthRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const count = await prisma.studioEvent.count({
        where: { type: 'knowledge:entry_created', timestamp: { gte: since } },
      });
      return count || 0;
    } catch { return null; }
  }

  /** Knowledge O2-KR2: 执行改善度 */
  private async queryExecutionImprovement(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await prisma.studioEvent.findMany({
        where: { type: { startsWith: 'knowledge:outcome' }, timestamp: { gte: since } },
        select: { type: true, payload: true },
      });
      if (events.length === 0) return null;
      // Compare success rate of executions that consumed knowledge vs baseline
      const withKnowledge = events.filter(e => {
        try { return JSON.parse(e.payload).consumedKnowledge?.length > 0; } catch { return false; }
      });
      if (withKnowledge.length === 0) return null;
      const successWithKnowledge = withKnowledge.filter(e => e.type.includes('success')).length;
      return Math.round((successWithKnowledge / withKnowledge.length) * 100);
    } catch { return null; }
  }

  // ── Batch C: queries (need infrastructure) ──

  /** Pipeline O3-KR4: 回滚率 — N/A (系统无 deploy rollback 机制，始终返回 0) */
  private async queryRollbackRate(_days: number): Promise<number | null> {
    return 0;
  }

  /** Pipeline O4-KR1: 最大并行数 */
  private async queryMaxConcurrent(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await prisma.studioEvent.findMany({
        where: { type: 'scheduler:parallel', timestamp: { gte: since } },
        select: { payload: true },
      });
      if (events.length === 0) return null;
      let max = 0;
      for (const e of events) {
        try {
          const p = JSON.parse(e.payload);
          if (p.concurrent > max) max = p.concurrent;
        } catch { /* skip */ }
      }
      return max || null;
    } catch { return null; }
  }

  /** Pipeline O4-KR2: 冲突率 */
  private async queryConflictRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const [total, conflicts] = await Promise.all([
        prisma.workUnit.count({ where: { createdAt: { gte: since }, parentId: { not: null } } }),
        prisma.studioEvent.count({ where: { type: 'scheduler:conflict', timestamp: { gte: since } } }),
      ]);
      if (total === 0) return null;
      return Math.round((conflicts / total) * 100);
    } catch { return null; }
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
    knowledge_entry_count: Infinity,
    knowledge_consumption_hit_rate: 100,
    resolution_count: Infinity,
    resolution_verify_rate: 100,
    incident_count: Infinity,
    deploy_success_rate: 100,
    deploy_failure_rate: 100,
    analyst_accuracy: 100,
    behavior_feedback_rate: 100,
    pipeline_cost_tokens: Infinity,
    session_duration_avg: Infinity,
    test_pass_rate: 100,
    pipeline_goal_cost: Infinity,
    queue_duration_avg: Infinity,
    knowledge_quality_gate_pass_rate: 100,
    knowledge_quality_score: 100,
    knowledge_search_hit_rate: 100,
    knowledge_quality_trend: 100,
    dedup_hit_rate: 100,
    knowledge_skill_created: Infinity,
    knowledge_skill_usage_rate: 100,
    knowledge_growth_rate: Infinity,
    execution_improvement: 100,
    rollback_rate: 100,
    max_concurrent: Infinity,
    conflict_rate: 100,
  };

  /** 获取 metricType 的系统基线值 */
  async getMetricBaseline(metricType: string, days = 7): Promise<number | null> {
    const kr: OKRKeyResult = {
      id: '_baseline_', objectiveId: '', title: '', target: 0, current: 0, unit: '',
      metricType, queryParams: { days },
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