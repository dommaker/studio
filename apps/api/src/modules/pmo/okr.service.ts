// OKR Service - PMO 模块核心服务
import { logger, FileStore, parseFrontmatter } from '@dommaker/studio-shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── 路径常量 ───
const STUDIO_DIR = path.join(os.homedir(), '.studio');
const OKR_DIR = path.join(STUDIO_DIR, 'okr');
const KR_HISTORY_JSONL = path.join(STUDIO_DIR, 'okr', 'kr-history.jsonl');
const EXECUTIONS_JSONL = path.join(STUDIO_DIR, 'logs', 'executions.jsonl');
const STUDIO_EVENTS_JSONL = path.join(STUDIO_DIR, 'logs', 'studio-events.jsonl');
const INCIDENTS_JSONL = path.join(STUDIO_DIR, 'logs', 'incidents.jsonl');
const RESOLUTIONS_DIR = path.join(STUDIO_DIR, 'knowledge', 'resolutions');

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
  metricType?: string;     // B8: 度量类型 e.g. "pipeline_duration_p90", "cache_hit_rate"
  queryParams?: Record<string, unknown>;  // B8: 查询参数 e.g. { days: 7 }
}

export interface KRActual {
  value: number | null;
  status: 'ok' | 'no_data' | 'stale';
  lastUpdated: Date;
}

export interface CreateOKRInput {
  companyId?: string;   // kept for backward compat
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
 * 获取当前季度
 */
export function getCurrentQuarter(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${year}-Q${quarter}`;
}

/** JSONL 行事件 */
interface StudioEventRow {
  type: string;
  timestamp: string;
  payload?: string;
}

interface ExecutionRow {
  id: string;
  okrId?: string | null;
  status?: string;
  startTime?: string;
  endTime?: string;
  createdAt?: string;
  progress?: number;
}

interface IncidentRow {
  id: string;
  detectedAt?: string;
}

/**
 * OKR 服务
 */
export class OKRService {
  private fileStore: FileStore;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  // ─── FileStore 辅助方法 ───

  private async readOKR(quarter: string): Promise<{ meta: Record<string, unknown>; body: string } | null> {
    return this.fileStore.readDoc(OKR_DIR, quarter);
  }

  /** 遍历所有 OKR 文件找到指定 id 对应的 quarter key */
  private async findOKRKey(id: string): Promise<string | null> {
    const keys = await this.fileStore.listDocs(OKR_DIR);
    for (const key of keys) {
      const doc = await this.fileStore.readDoc(OKR_DIR, key);
      if (doc && doc.meta.id === id) return key;
    }
    return null;
  }

  /** 从 studio 事件 jsonl 中按 type 和时间范围过滤 */
  private async readEvents(type: string, since: Date): Promise<StudioEventRow[]> {
    const rows = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
    return rows.filter(r => r.type === type && new Date(r.timestamp).getTime() >= since.getTime());
  }

  /** 解析 meta 中的 objectives/keyResults JSON 字符串 */
  private parseOKRMeta(meta: Record<string, unknown>): { objectives: OKRObjective[]; keyResults: OKRKeyResult[] } {
    const objectives: OKRObjective[] = typeof meta.objectives === 'string'
      ? JSON.parse(meta.objectives) : (meta.objectives as OKRObjective[] || []);
    const keyResults: OKRKeyResult[] = typeof meta.keyResults === 'string'
      ? JSON.parse(meta.keyResults) : (meta.keyResults as OKRKeyResult[] || []);
    return { objectives, keyResults };
  }

  /**
   * 创建 OKR
   */
  async create(input: CreateOKRInput) {
    // 检查是否已存在相同 quarter 的 OKR
    const existing = await this.readOKR(input.quarter);
    if (existing) {
      throw new Error(`OKR for quarter ${input.quarter} already exists`);
    }

    // 计算初始进度
    const progress = this.calculateProgress(input.keyResults);
    const id = `okr_${Date.now()}`;
    const now = new Date().toISOString();

    const meta: Record<string, unknown> = {
      id,
      status: 'active',
      progress,
      title: input.title,
      quarter: input.quarter,
      companyId: input.companyId || '',
      createdAt: now,
      updatedAt: now,
      objectives: JSON.stringify(input.objectives),
      keyResults: JSON.stringify(input.keyResults),
    };

    const body = `## OKR: ${input.title}\n\nQuarter: ${input.quarter}\n\n### Objectives\n${
      input.objectives.map(o => `- ${o.title}`).join('\n')
    }\n\n### Key Results\n${
      input.keyResults.map(kr => `- ${kr.title}: ${kr.current}/${kr.target} ${kr.unit}`).join('\n')
    }`;

    await this.fileStore.writeDoc(OKR_DIR, input.quarter, meta, body);

    logger.info('OKR created', { okrId: id, quarter: input.quarter });
    return { id, ...meta, objectives: input.objectives, keyResults: input.keyResults };
  }

  /**
   * 获取 OKR 列表
   */
  async list(companyId: string, options?: { status?: string }) {
    const keys = await this.fileStore.listDocs(OKR_DIR);
    const docs: { meta: Record<string, unknown>; body: string; key: string }[] = [];

    for (const key of keys) {
      const doc = await this.fileStore.readDoc(OKR_DIR, key);
      if (!doc) continue;
      if (doc.meta.companyId !== companyId) continue;
      if (options?.status && doc.meta.status !== options.status) continue;
      docs.push({ ...doc, key });
    }

    // orderBy createdAt desc
    docs.sort((a, b) => new Date(b.meta.createdAt as string).getTime() - new Date(a.meta.createdAt as string).getTime());

    // 批量读取 executions jsonl 计算每个 OKR 的项目数
    const allExecs = await this.fileStore.readJsonl<ExecutionRow>(EXECUTIONS_JSONL);
    const execCountByOkr = new Map<string, number>();
    for (const e of allExecs) {
      if (e.okrId) {
        execCountByOkr.set(e.okrId, (execCountByOkr.get(e.okrId) || 0) + 1);
      }
    }

    return docs.map(d => {
      const parsed = this.parseOKRMeta(d.meta);
      return {
        id: d.meta.id,
        companyId: d.meta.companyId,
        title: d.meta.title,
        quarter: d.meta.quarter,
        status: d.meta.status,
        progress: d.meta.progress,
        objectives: parsed.objectives,
        keyResults: parsed.keyResults,
        createdAt: d.meta.createdAt,
        updatedAt: d.meta.updatedAt,
        projectCount: execCountByOkr.get(d.meta.id as string) || 0,
      };
    });
  }

  /**
   * 获取 OKR 详情
   */
  async get(id: string) {
    const key = await this.findOKRKey(id);
    if (!key) {
      throw new Error('OKR not found');
    }
    const doc = await this.readOKR(key);
    if (!doc) throw new Error('OKR not found');

    const parsed = this.parseOKRMeta(doc.meta);
    const allExecs = await this.fileStore.readJsonl<ExecutionRow>(EXECUTIONS_JSONL);
    const recentExecs = allExecs
      .filter(e => e.okrId === id)
      .sort((a, b) => new Date(b.createdAt || '').getTime() - new Date(a.createdAt || '').getTime())
      .slice(0, 10)
      .map(e => ({ id: e.id, status: e.status, startTime: e.startTime, endTime: e.endTime }));

    return {
      id: doc.meta.id,
      companyId: doc.meta.companyId,
      title: doc.meta.title,
      quarter: doc.meta.quarter,
      status: doc.meta.status,
      progress: doc.meta.progress,
      objectives: parsed.objectives,
      keyResults: parsed.keyResults,
      createdAt: doc.meta.createdAt,
      updatedAt: doc.meta.updatedAt,
      Company: null,
      Execution: recentExecs,
      _count: { Execution: allExecs.filter(e => e.okrId === id).length },
    };
  }

  /**
   * 更新 OKR
   */
  async update(id: string, input: UpdateOKRInput) {
    const key = await this.findOKRKey(id);
    if (!key) {
      throw new Error('OKR not found');
    }
    const doc = await this.readOKR(key);
    if (!doc) throw new Error('OKR not found');

    const parsed = this.parseOKRMeta(doc.meta);
    let progress = doc.meta.progress as number;
    let updatedKR = parsed.keyResults;
    let updatedObj = parsed.objectives;

    if (input.keyResults) {
      updatedKR = input.keyResults;
      progress = this.calculateProgress(input.keyResults);
    }
    if (input.objectives) {
      updatedObj = input.objectives;
    }

    const now = new Date().toISOString();
    const meta: Record<string, unknown> = {
      ...doc.meta,
      title: input.title ?? doc.meta.title,
      status: input.status ?? doc.meta.status,
      progress,
      objectives: JSON.stringify(updatedObj),
      keyResults: JSON.stringify(updatedKR),
      updatedAt: now,
    };

    const bodyLines: string[] = [];
    bodyLines.push(`## OKR: ${meta.title}\n`);
    bodyLines.push(`Quarter: ${meta.quarter}\n`);
    bodyLines.push('### Objectives');
    for (const o of updatedObj) {
      bodyLines.push(`- ${o.title}`);
    }
    bodyLines.push('');
    bodyLines.push('### Key Results');
    for (const kr of updatedKR) {
      bodyLines.push(`- ${kr.title}: ${kr.current}/${kr.target} ${kr.unit}`);
    }

    await this.fileStore.writeDoc(OKR_DIR, key, meta, bodyLines.join('\n'));

    logger.info('OKR updated', { okrId: id });
    return { id, ...meta, objectives: updatedObj, keyResults: updatedKR };
  }

  /**
   * 删除 OKR
   */
  async delete(id: string) {
    const key = await this.findOKRKey(id);
    if (!key) {
      throw new Error('OKR not found');
    }

    // 从 executions jsonl 中解除关联
    const allExecs = await this.fileStore.readJsonl<ExecutionRow>(EXECUTIONS_JSONL);
    const linked = allExecs.filter(e => e.okrId === id);
    if (linked.length > 0) {
      const updated = allExecs.map(e => e.okrId === id ? { ...e, okrId: null } : e);
      await fs.promises.mkdir(path.dirname(EXECUTIONS_JSONL), { recursive: true });
      await fs.promises.writeFile(EXECUTIONS_JSONL, updated.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    }

    // 删除 OKR 文件
    await fs.promises.unlink(path.join(OKR_DIR, `${key}.md`));

    logger.info('OKR deleted', { okrId: id, executionCount: linked.length });
    return { success: true, unlinkedProjects: linked.length };
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
   * 检查权限（Role 功能已废弃，返回 false）
   */
  async checkPermission(_roleId: string, _companyId: string): Promise<boolean> {
    // Role 功能已在 Agent Network 架构中废弃
    return false;
  }

  /**
   * 获取公司当前季度默认 OKR
   */
  async getDefaultOKR(companyId: string): Promise<string | null> {
    const currentQuarter = getCurrentQuarter();
    const keys = await this.fileStore.listDocs(OKR_DIR);

    let latest: string | null = null;
    let latestTs = 0;

    for (const key of keys) {
      const doc = await this.fileStore.readDoc(OKR_DIR, key);
      if (doc && doc.meta.companyId === companyId && doc.meta.quarter === currentQuarter && doc.meta.status === 'active') {
        const ts = new Date(doc.meta.createdAt as string).getTime();
        if (ts > latestTs) {
          latest = doc.meta.id as string;
          latestTs = ts;
        }
      }
    }

    return latest;
  }

  /**
   * 创建默认 OKR（公司创建时）
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

    logger.info('Default OKR created', { companyId, okrId: okr.id as string, quarter: currentQuarter });
    return { id: okr.id as string, title: (okr as any).title as string, quarter: (okr as any).quarter as string };
  }

  /**
   * 更新 OKR 进度（基于关联项目）
   */
  async updateProgress(okrId: string): Promise<number> {
    const projectsDir = path.join(os.homedir(), '.studio', 'projects');
    let allProjects: any[] = [];
    try {
      const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        const data = await fileStore.readJson<any>(path.join(projectsDir, e.name));
        if (data) allProjects.push(data);
      }
    } catch { /* no projects dir */ }
    const projects = allProjects.filter((p: any) => p.okrId === okrId)
      .map((p: any) => ({ progress: p.progress ?? 0, status: p.status }));

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
    const rounded = Math.round(avgProgress);

    // 更新 OKR 文件中的进度
    const key = await this.findOKRKey(okrId);
    if (key) {
      const doc = await this.readOKR(key);
      if (doc) {
        doc.meta.progress = rounded;
        doc.meta.updatedAt = new Date().toISOString();
        const body = doc.body;
        await this.fileStore.writeDoc(OKR_DIR, key, doc.meta, body);
      }
    }

    logger.info('OKR progress updated', { okrId, progress: rounded, projectCount: activeProjects.length });
    return rounded;
  }

  // ── B8: OKR 驱动闭环 ──

  /**
   * 检查数据源可用性
   */
  async checkDataSourceHealth(): Promise<Record<string, 'ok' | 'empty'>> {
    const [studioEvents, snapshots] = await Promise.all([
      this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL),
      this.fileStore.getIndex(),
    ]);
    return {
      studio_event: studioEvents.length > 0 ? 'ok' : 'empty',
      execution: snapshots.length > 0 ? 'ok' : 'empty',
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
    execution_success_rate: {
      dataSource: 'execution',
      query: (okr, days) => okr.queryExecutionSuccessRate(days),
      description: '执行成功率',
    },
    review_pass_rate: {
      dataSource: 'execution',
      query: (okr, days) => okr.queryReviewPassRate(days),
      description: '审查通过率',
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
    session_duration_avg: {
      dataSource: 'execution',
      query: (okr, days) => okr.querySessionDurationAvg(days),
      description: '平均会话时长',
    },
    // ── Batch A: OKR metricTypes (data source exists) ──
    queue_duration_avg: {
      dataSource: 'execution',
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
    max_concurrent: {
      dataSource: 'execution',
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
      // 更新 OKR 文件
      const key = await this.findOKRKey(okrId);
      if (key) {
        const doc = await this.readOKR(key);
        if (doc) {
          doc.meta.keyResults = JSON.stringify(krs);
          doc.meta.progress = progress;
          doc.meta.updatedAt = new Date().toISOString();
          await this.fileStore.writeDoc(OKR_DIR, key, doc.meta, doc.body);
        }
      }
    }

    // 写 KRHistory 记录 (append to jsonl)
    const now = new Date();
    for (const r of results) {
      const matchedKr = krs.find(k => k.current === r.value || r.value === null);
      await this.fileStore.appendJsonl(KR_HISTORY_JSONL, {
        krId: matchedKr?.id || 'unknown',
        okrId,
        value: r.value ?? 0,
        status: r.status,
        timestamp: now.toISOString(),
      });
    }

    logger.info('KR progress synced', { okrId, results: results.map(r => r.status) });
    return results;
  }

  /**
   * 按 metricType 查询 KR 实际值
   */
  private async queryKRActual(kr: OKRKeyResult): Promise<number | null> {
    const days = (kr.queryParams?.days as number) || 7;
    const entry = kr.metricType ? OKRService.METRIC_REGISTRY[kr.metricType] : null;

    if (!entry) {
      if (kr.metricType) logger.warn('Unknown metricType', { metricType: kr.metricType });
      return null;
    }

    return entry.query(this, days, kr.queryParams);
  }

  // ── 具体 metric 查询 ──

  /** 执行成功率 */
  private async queryExecutionSuccessRate(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const sinceMs = since.getTime();
    const snapshots = await this.fileStore.getIndex();
    const total = snapshots.filter(s => new Date(s.createdAt).getTime() >= sinceMs && s.status !== 'unassigned').length;
    const succeeded = snapshots.filter(s => new Date(s.createdAt).getTime() >= sinceMs && s.status === 'done').length;

    if (total === 0) return null;
    return Math.round((succeeded / total) * 100);
  }

  /** 审查通过率 */
  private async queryReviewPassRate(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const sinceMs = since.getTime();
    const snapshots = await this.fileStore.getIndex();
    const workUnits = snapshots.filter(s => new Date(s.createdAt).getTime() >= sinceMs && ['done', 'closed'].includes(s.status));

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
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      const injected = events.filter(e => e.type === 'knowledge:injected' && new Date(e.timestamp).getTime() >= since.getTime()).length;
      const consumed = events.filter(e => e.type === 'knowledge:consumption' && new Date(e.timestamp).getTime() >= since.getTime()).length;
      if (injected === 0) return null;
      return Math.round((consumed / injected) * 100);
    } catch { return null; }
  }

  private async queryResolutionCount(_days: number): Promise<number | null> {
    try {
      let count = 0;
      try {
        const entries = await fs.promises.readdir(RESOLUTIONS_DIR, { withFileTypes: true });
        count = entries.filter(e => e.isFile() && e.name.endsWith('.md')).length;
      } catch {
        // dir may not exist
      }
      return count;
    } catch { return null; }
  }

  private async queryResolutionVerifyRate(_days: number): Promise<number | null> {
    try {
      let total = 0;
      let verified = 0;
      try {
        const entries = await fs.promises.readdir(RESOLUTIONS_DIR, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          total++;
          try {
            const content = await fs.promises.readFile(path.join(RESOLUTIONS_DIR, entry.name), 'utf-8');
            const parsed = parseFrontmatter(content);
            if (parsed && parsed.meta.maturity === 'verified') verified++;
          } catch { /* skip unreadable */ }
        }
      } catch {
        // dir may not exist
      }
      if (total === 0) return null;
      return Math.round((verified / total) * 100);
    } catch { return null; }
  }

  private async queryIncidentCount(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const incidents = await this.fileStore.readJsonl<IncidentRow>(INCIDENTS_JSONL);
      return incidents.filter(i => i.detectedAt && new Date(i.detectedAt).getTime() >= since.getTime()).length;
    } catch { return null; }
  }

  private async queryDeploySuccessRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.readEvents('deploy.completed', since);
      if (events.length === 0) return null;
      const success = events.filter(e => {
        try {
          const p = JSON.parse(e.payload!);
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
      const events = await this.readEvents('deploy.completed', since);
      if (events.length === 0) return null;
      const failures = events.filter(e => {
        try {
          const p = JSON.parse(e.payload!);
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
      const events = await this.readEvents('knowledge:analyst_accuracy', since);
      if (events.length === 0) return null;
      const accurate = events.filter(e => {
        try { return JSON.parse(e.payload!).accurate; } catch { return false; }
      }).length;
      return Math.round((accurate / events.length) * 100);
    } catch { return null; }
  }

  private async queryBehaviorFeedbackRate(_days: number): Promise<number | null> {
    // UserBehaviorProfile table deleted — feedback rate metric unavailable
    return null;
  }

  private async querySessionDurationAvg(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const sinceMs = since.getTime();
      const snapshots = await this.fileStore.getIndex();
      const execs = snapshots.filter(s =>
        s.status === 'done' && s.claimedAt && s.completedAt && new Date(s.claimedAt).getTime() >= sinceMs
      );
      if (execs.length === 0) return null;
      const totalMs = execs.reduce((sum, e) =>
        sum + (new Date(e.completedAt!).getTime() - new Date(e.claimedAt!).getTime()), 0);
      return Math.round(totalMs / execs.length / 1000 / 60); // minutes
    } catch { return null; }
  }

  // ── Batch A: OKR metricType queries (data source exists) ──

  /** Pipeline O4-KR3: 排队时间 (WorkUnit.createdAt → child.claimedAt) */
  private async queryQueueDurationAvg(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const sinceMs = since.getTime();
      const snapshots = await this.fileStore.getIndex();
      const childUnits = snapshots.filter(s => s.parentId !== null && new Date(s.createdAt).getTime() >= sinceMs);
      if (childUnits.length === 0) return null;

      const waits: number[] = [];
      for (const w of childUnits) {
        if (w.claimedAt) {
          waits.push(new Date(w.claimedAt).getTime() - new Date(w.createdAt).getTime());
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
      const events = await this.readEvents('extractFromExecution', since);
      if (events.length === 0) return null;
      const success = events.filter(e => {
        try { return JSON.parse(e.payload!).success; } catch { return false; }
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
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      const searches = events.filter(e => e.type === 'knowledge:search' && new Date(e.timestamp).getTime() >= since.getTime()).length;
      const hits = events.filter(e => e.type === 'knowledge:search_hit' && new Date(e.timestamp).getTime() >= since.getTime()).length;
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
      const events = await this.readEvents('knowledge:quality_gate', since);
      if (events.length === 0) return null;
      const skipped = events.filter(e => {
        try { return JSON.parse(e.payload!).skipped; } catch { return false; }
      }).length;
      return Math.round((skipped / events.length) * 100);
    } catch { return null; }
  }

  /** Knowledge O3-KR1: Skill 生成数 */
  private async querySkillCreated(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      return events.filter(e => e.type === 'knowledge:skill_created' && new Date(e.timestamp).getTime() >= since.getTime()).length;
    } catch { return null; }
  }

  /** Knowledge O3-KR2: Skill 使用率 (used / total published on disk) */
  private async querySkillUsageRate(days: number): Promise<number | null> {
    try {
      // count published skills from disk (no StudioEvent needed)
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
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      const used = events.filter(e => e.type === 'knowledge:skill_used' && new Date(e.timestamp).getTime() >= since.getTime()).length;
      return Math.round((used / total) * 100);
    } catch { return null; }
  }

  /** Knowledge O3-KR3: 知识增速 */
  private async queryKnowledgeGrowthRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      return events.filter(e => e.type === 'knowledge:entry_created' && new Date(e.timestamp).getTime() >= since.getTime()).length;
    } catch { return null; }
  }

  /** Knowledge O2-KR2: 执行改善度 */
  private async queryExecutionImprovement(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      const filtered = events.filter(e =>
        e.type.startsWith('knowledge:outcome') && new Date(e.timestamp).getTime() >= since.getTime()
      );
      if (filtered.length === 0) return null;
      const withKnowledge = filtered.filter(e => {
        try { return JSON.parse(e.payload!).consumedKnowledge?.length > 0; } catch { return false; }
      });
      if (withKnowledge.length === 0) return null;
      const successWithKnowledge = withKnowledge.filter(e => e.type.includes('success')).length;
      return Math.round((successWithKnowledge / withKnowledge.length) * 100);
    } catch { return null; }
  }

  // ── Batch C: queries (need infrastructure) ──

  /** Pipeline O4-KR1: 最大并行数 */
  private async queryMaxConcurrent(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.readEvents('scheduler:parallel', since);
      if (events.length === 0) return null;
      let max = 0;
      for (const e of events) {
        try {
          const p = JSON.parse(e.payload!);
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
      const sinceMs = since.getTime();
      const [snapshots, events] = await Promise.all([
        this.fileStore.getIndex(),
        this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL),
      ]);
      const conflicts = events.filter(e => e.type === 'scheduler:conflict' && new Date(e.timestamp).getTime() >= sinceMs).length;
      const total = snapshots.filter(s => s.parentId !== null && new Date(s.createdAt).getTime() >= sinceMs).length;
      if (total === 0) return null;
      return Math.round((conflicts / total) * 100);
    } catch { return null; }
  }

  // ── B8 Phase 1.5: KR 目标校验 ──

  /** 理论上限 */
  private static readonly UPPER_BOUNDS: Record<string, number> = {
    execution_success_rate: 100,
    review_pass_rate: 100,
    knowledge_entry_count: Infinity,
    knowledge_consumption_hit_rate: 100,
    resolution_count: Infinity,
    resolution_verify_rate: 100,
    incident_count: Infinity,
    deploy_success_rate: 100,
    deploy_failure_rate: 100,
    analyst_accuracy: 100,
    behavior_feedback_rate: 100,
    session_duration_avg: Infinity,
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
      logger.warn('[OKR] Recalibration failed', { error: String(e) });
    }
    return suggestions;
  }
}

export const okrService = new OKRService();
