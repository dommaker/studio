// OKR Service - PMO 模块核心服务
import { logger, FileStore } from '@dommaker/studio-shared';
import { studioDir } from '@dommaker/studio-shared/studio-dir';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── 路径常量 ───
const STUDIO_DIR = studioDir();
const OKR_DIR = path.join(STUDIO_DIR, 'okr');
const EXECUTIONS_JSONL = path.join(STUDIO_DIR, 'logs', 'executions.jsonl');

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

interface ExecutionRow {
  id: string;
  okrId?: string | null;
  status?: string;
  startTime?: string;
  endTime?: string;
  createdAt?: string;
  progress?: number;
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

}

export const okrService = new OKRService();
