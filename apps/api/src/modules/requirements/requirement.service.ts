/**
 * Requirement Service — REQ 需求编号体系（vision §5.3）
 *
 * Requirement 是一组 WorkUnit 的父实体：编号 REQ-<seq> 在频道首次
 * @mention 派发时自动分配（best-effort，见 req-binding.ts），也可手动创建。
 * 存储：FileStore `~/.studio/data/requirements/{id}.json` + index.json 序号计数器。
 *
 * B3a 工程归属链（决策 D2）：Requirement 可挂 PMO 项目（projectId），
 * 创建/更新时校验项目存在；WU 归属解析经此继承 PMO 项目 gitRepo（见 ownership-resolver.ts）。
 *
 * PMO-a 别名层（2026-07-28 分析文档，决策 4）：REQ 退化为 PMO 的只读别名——
 * get/list 先查统一编号 PMO（reqAlias 命中 → 投影为 REQ 视图，projectId = PMO 自身 id），
 * 查不到才回落 legacy REQ 记录；update/maybeRollUpToDone 对别名视图只读跳过
 * （PMO 状态由 progress-rollup 拥有）。createFromDispatch：频道已登记杂务 PMO（决策 2）
 * 时小活归集到杂务 PMO 别名；未登记 → legacy 自动新建（归类判断在入口澄清环节做）。
 */
import {
  eventBus,
  FileStore,
  formatRequirementId,
  logger,
  type RequirementData,
  type RequirementStatus,
} from '@dommaker/studio-shared';
import { projectService, type ProjectData } from '../pmo/project.service.js';

export const REQUIREMENT_STATUSES: RequirementStatus[] = ['open', 'in-progress', 'done', 'archived'];

/**
 * B3a 工程归属链（决策 D2）：Requirement 可挂 PMO 项目（projectId，工程归属锚点）。
 * studio-shared 的 RequirementData 暂未加该字段（本批改动限 apps/api/src），
 * FileStore 读写原样透传 JSON —— 本地扩展类型承载，运行时无差异。
 */
export type RequirementWithProject = RequirementData & {
  projectId?: string | null; // B3a: 挂接的 PMO 项目 id（WU 经此继承工程 gitRepo）
};

/** RequirementService 可注入依赖（测试用 stub 避免碰真实 ~/.studio/projects） */
export interface RequirementServiceDeps {
  projectExists?: (projectId: string) => Promise<boolean>;
  /** 决策 4 别名层：REQ id → 统一编号 PMO（默认 projectService.getByReqAlias） */
  getProjectByAlias?: (reqId: string) => Promise<ProjectData | null>;
  /** 决策 2：频道杂务 PMO 只查不建（默认 projectService.findChoreProject；零副作用） */
  findChoreProject?: (channelId: string) => Promise<ProjectData | null>;
  /** 决策 4：全量别名对象扫描（默认 projectService.list 大页；list 合并用） */
  listAliasProjects?: () => Promise<ProjectData[]>;
  /** 决策 4：#PMO-n token 解析（默认 projectService.getByPmoNumber；req-binding 用） */
  getProjectByPmoNumber?: (pmoNumber: string) => Promise<ProjectData | null>;
}

/** PMO 状态 → REQ 状态视图映射（别名层只读投影） */
function projectStatusToReqStatus(status: string): RequirementStatus {
  switch (status) {
    case 'active':
    case 'in_review':
      return 'in-progress';
    case 'completed':
      return 'done';
    case 'cancelled':
      return 'archived';
    default:
      return 'open'; // pending
  }
}

/** 决策 4：统一编号 PMO → REQ 只读别名视图（projectId = PMO 自身 id，归属/回写链不变） */
export function toRequirementAliasView(p: ProjectData): RequirementWithProject {
  return {
    id: p.reqAlias!,
    seq: parseInt(p.reqAlias!.slice(4), 10),
    title: p.title,
    status: projectStatusToReqStatus(p.status),
    channelId: p.channelId ?? null,
    createdAt: p.createdAt,
    createdBy: 'pmo-alias',
    projectId: p.id,
    ...(p.description ? { description: p.description } : {}),
    ...(p.requirementsDocId ? { docs: [p.requirementsDocId] } : {}),
  };
}

/**
 * WorkUnit 终态集合 — 全部到达时 Requirement 汇总为 done。
 * in_review 视同工作完成（待人类确认）；completed/failed 兼容外部写入的状态值。
 */
export const TERMINAL_WORKUNIT_STATUSES = ['in_review', 'done', 'completed', 'failed', 'closed'];

export interface CreateRequirementInput {
  title: string;
  channelId?: string | null;
  createdBy?: string;
  status?: RequirementStatus;
  description?: string;
  docs?: string[];
  projectId?: string | null; // B3a: 挂接 PMO 项目（给定且非 null 时校验项目存在）
}

export interface UpdateRequirementInput {
  title?: string;
  status?: RequirementStatus;
  description?: string;
  docs?: string[];
  projectId?: string | null; // B3a: 挂接/更换 PMO 项目；null = 清除挂接
}

/** getChain 返回的 WorkUnit 摘要（UI 全链路视图用） */
export interface RequirementChainWorkUnit {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
}

export interface RequirementChain {
  requirement: RequirementData;
  workunits: RequirementChainWorkUnit[];
}

/** 从派发消息推导需求标题：压缩空白后取前 ~80 字符 */
export function deriveTitle(message: string): string {
  const cleaned = message.replace(/\s+/g, ' ').trim();
  return cleaned.length > 80 ? cleaned.slice(0, 80).trimEnd() : cleaned;
}

export class RequirementService {
  private fileStore: FileStore;
  private projectExists: (projectId: string) => Promise<boolean>;
  private getProjectByAlias: (reqId: string) => Promise<ProjectData | null>;
  private findChoreProject: (channelId: string) => Promise<ProjectData | null>;
  private listAliasProjects: () => Promise<ProjectData[]>;
  private getProjectByPmoNumber: (pmoNumber: string) => Promise<ProjectData | null>;

  constructor(fileStore?: FileStore, deps?: RequirementServiceDeps) {
    this.fileStore = fileStore ?? new FileStore();
    this.projectExists = deps?.projectExists ?? (async id => (await projectService.get(id)) !== null);
    this.getProjectByAlias = deps?.getProjectByAlias ?? (async id => projectService.getByReqAlias(id));
    this.findChoreProject = deps?.findChoreProject ?? (async id => projectService.findChoreProject(id));
    this.listAliasProjects = deps?.listAliasProjects ?? (async () => projectService.list({ limit: 100000 }));
    this.getProjectByPmoNumber = deps?.getProjectByPmoNumber ?? (async n => projectService.getByPmoNumber(n));
  }

  /** 决策 4：#PMO-n token → REQ 别名（仅统一编号对象可解析；存量无别名 → null） */
  async resolveReqAliasByPmoNumber(pmoNumber: string): Promise<string | null> {
    const project = await this.getProjectByPmoNumber(pmoNumber);
    return project?.reqAlias ?? null;
  }

  /**
   * 创建需求（flock 原子分配 seq）。
   * 发布 requirement.created（best-effort）。
   * B3a: 给定 projectId 时校验 PMO 项目存在，不存在抛错（不落档）。
   */
  async create(input: CreateRequirementInput): Promise<RequirementWithProject> {
    if (input.projectId) await this.assertProjectExists(input.projectId);
    const seq = await this.fileStore.allocateRequirementSeq();
    const requirement: RequirementWithProject = {
      id: formatRequirementId(seq),
      seq,
      title: input.title,
      status: input.status ?? 'open',
      channelId: input.channelId ?? null,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? 'manual',
      projectId: input.projectId ?? null,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.docs !== undefined ? { docs: input.docs } : {}),
    };
    await this.fileStore.createRequirement(requirement);
    this.publish('requirement.created', requirement);
    return requirement;
  }

  /**
   * 派发路径自动创建（决策 2）：频道已登记杂务 PMO → 小活归集到杂务 PMO 的 REQ 别名
   * （只查不建，热路径零副作用）；未登记 → legacy 自动新建
   * （title 取消息前 ~80 字符，status=in-progress，channelId 落档）。
   * 需求级工作单建 PMO 的归类判断在入口澄清环节做，不在本函数。
   */
  async createFromDispatch(message: string, channelId: string | null, createdBy: string): Promise<RequirementData> {
    if (channelId) {
      const chore = await this.findChoreProject(channelId);
      if (chore?.reqAlias) return toRequirementAliasView(chore);
    }
    return this.create({
      title: deriveTitle(message),
      status: 'in-progress',
      channelId,
      createdBy,
    });
  }

  /** 决策 4 别名层：REQ id 先查统一编号 PMO（命中 → 只读别名视图），否则 legacy 记录 */
  async get(id: string): Promise<RequirementWithProject | null> {
    if (/^REQ-\d+$/i.test(id)) {
      const alias = await this.getProjectByAlias(id.toUpperCase());
      if (alias) return toRequirementAliasView(alias);
    }
    return (await this.fileStore.getRequirement(id)) as RequirementWithProject | null;
  }

  /** 决策 4：legacy REQ + 别名视图合并（按 id 去重，别名优先；过滤在合并后应用） */
  async list(filter?: { status?: string; channelId?: string }): Promise<RequirementWithProject[]> {
    const legacy = (await this.fileStore.listRequirements(filter)) as RequirementWithProject[];
    const aliasProjects = await this.listAliasProjects();
    const legacyIds = new Set(legacy.map(r => r.id));
    const aliasViews = aliasProjects
      .filter(p => typeof p.reqAlias === 'string' && p.reqAlias && !legacyIds.has(p.reqAlias))
      .map(p => toRequirementAliasView(p))
      .filter(r => (!filter?.status || r.status === filter.status)
        && (!filter?.channelId || r.channelId === filter.channelId));
    return [...legacy, ...aliasViews];
  }

  /**
   * 更新需求（status/title/docs/description/projectId）。
   * 发布 requirement.updated（best-effort）。
   * B3a: projectId 非 null 时校验 PMO 项目存在；null = 清除挂接。
   * 决策 4：别名视图只读——命中统一编号 PMO 的 REQ id 不可经 REQ 通道更新（请改 PMO）。
   */
  async update(id: string, input: UpdateRequirementInput): Promise<RequirementWithProject> {
    if (/^REQ-\d+$/i.test(id) && (await this.getProjectByAlias(id.toUpperCase()))) {
      throw new Error(`Requirement ${id} is a read-only PMO alias — update the PMO project instead`);
    }
    const patch: Partial<RequirementWithProject> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.status !== undefined) patch.status = input.status;
    if (input.description !== undefined) patch.description = input.description;
    if (input.docs !== undefined) patch.docs = input.docs;
    if (input.projectId !== undefined) {
      if (input.projectId) await this.assertProjectExists(input.projectId);
      patch.projectId = input.projectId;
    }
    const updated = (await this.fileStore.updateRequirement(id, patch)) as RequirementWithProject;
    this.publish('requirement.updated', updated);
    return updated;
  }

  /** 关联文档（去重追加） */
  async addDoc(id: string, docPath: string): Promise<RequirementWithProject> {
    const existing = await this.fileStore.getRequirement(id);
    if (!existing) throw new Error(`Requirement not found: ${id}`);
    const docs = [...new Set([...(existing.docs ?? []), docPath])];
    return this.update(id, { docs });
  }

  /** B3a: 校验 PMO 项目存在（挂接 projectId 前置检查） */
  private async assertProjectExists(projectId: string): Promise<void> {
    if (!(await this.projectExists(projectId))) {
      throw new Error(`Project not found: ${projectId}`);
    }
  }

  /**
   * 全链路数据：需求 + 其 WorkUnit 摘要列表（id/title/status/assignee/metadata）。
   * 需求不存在返回 null。决策 4：别名视图经 get() 单点解析，同样可出链路。
   */
  async getChain(id: string): Promise<RequirementChain | null> {
    const requirement = await this.get(id);
    if (!requirement) return null;
    const snapshots = (await this.fileStore.getIndex()).filter(s => s.reqId === id);
    snapshots.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return {
      requirement,
      workunits: snapshots.map(s => ({
        id: s.id,
        title: extractWorkUnitTitle(s.metadata, s.scope),
        status: s.status,
        assigneeId: s.assigneeId,
        metadata: s.metadata,  // F6-b：链路节点徽章走 deriveDisplayState，需要台账
      })),
    };
  }

  /**
   * 状态汇总（vision §5.3）：需求的全部 WorkUnit 到达终态 → status = done。
   * 幂等；无 WorkUnit / 已 done / 已 archived 时不动作。返回是否发生了汇总。
   * 决策 4：别名视图跳过——PMO 状态由 progress-rollup 拥有（REQ 汇总不写别名）。
   */
  async maybeRollUpToDone(reqId: string): Promise<boolean> {
    const requirement = await this.get(reqId);
    if (!requirement || requirement.status === 'done' || requirement.status === 'archived') return false;
    if (requirement.createdBy === 'pmo-alias') return false;
    const snapshots = (await this.fileStore.getIndex()).filter(s => s.reqId === reqId);
    if (snapshots.length === 0) return false;
    if (!snapshots.every(s => TERMINAL_WORKUNIT_STATUSES.includes(s.status))) return false;
    await this.update(reqId, { status: 'done' });
    logger.info('[Requirement] Rolled up to done', { reqId, workUnitCount: snapshots.length });
    return true;
  }

  private publish(event: 'requirement.created' | 'requirement.updated', requirement: RequirementData): void {
    try {
      eventBus.publish(event, { requirement });
    } catch (err) {
      logger.warn(`[Requirement] Failed to publish ${event} (non-blocking)`, {
        reqId: requirement.id,
        error: String(err),
      });
    }
  }
}

/** WorkUnit 标题：优先 metadata.title，否则 scope 截断 */
function extractWorkUnitTitle(metadata: string | null, scope: string): string {
  if (metadata) {
    try {
      const meta = JSON.parse(metadata) as { title?: unknown };
      if (typeof meta.title === 'string' && meta.title) return meta.title;
    } catch { /* fall through to scope */ }
  }
  return scope.length > 80 ? scope.slice(0, 80) : scope;
}
