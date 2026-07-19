/**
 * Requirement Service — REQ 需求编号体系（vision §5.3）
 *
 * Requirement 是一组 WorkUnit 的父实体：编号 REQ-<seq> 在频道首次
 * @mention 派发时自动分配（best-effort，见 req-binding.ts），也可手动创建。
 * 存储：FileStore `~/.studio/data/requirements/{id}.json` + index.json 序号计数器。
 */
import {
  eventBus,
  FileStore,
  formatRequirementId,
  logger,
  type RequirementData,
  type RequirementStatus,
} from '@dommaker/studio-shared';

export const REQUIREMENT_STATUSES: RequirementStatus[] = ['open', 'in-progress', 'done', 'archived'];

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
}

export interface UpdateRequirementInput {
  title?: string;
  status?: RequirementStatus;
  description?: string;
  docs?: string[];
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

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  /**
   * 创建需求（flock 原子分配 seq）。
   * 发布 requirement.created（best-effort）。
   */
  async create(input: CreateRequirementInput): Promise<RequirementData> {
    const seq = await this.fileStore.allocateRequirementSeq();
    const requirement: RequirementData = {
      id: formatRequirementId(seq),
      seq,
      title: input.title,
      status: input.status ?? 'open',
      channelId: input.channelId ?? null,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? 'manual',
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.docs !== undefined ? { docs: input.docs } : {}),
    };
    await this.fileStore.createRequirement(requirement);
    this.publish('requirement.created', requirement);
    return requirement;
  }

  /**
   * 派发路径自动创建：title 取消息前 ~80 字符，status=in-progress，channelId 落档。
   */
  async createFromDispatch(message: string, channelId: string | null, createdBy: string): Promise<RequirementData> {
    return this.create({
      title: deriveTitle(message),
      status: 'in-progress',
      channelId,
      createdBy,
    });
  }

  async get(id: string): Promise<RequirementData | null> {
    return this.fileStore.getRequirement(id);
  }

  async list(filter?: { status?: string; channelId?: string }): Promise<RequirementData[]> {
    return this.fileStore.listRequirements(filter);
  }

  /**
   * 更新需求（status/title/docs/description）。
   * 发布 requirement.updated（best-effort）。
   */
  async update(id: string, input: UpdateRequirementInput): Promise<RequirementData> {
    const patch: Partial<RequirementData> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.status !== undefined) patch.status = input.status;
    if (input.description !== undefined) patch.description = input.description;
    if (input.docs !== undefined) patch.docs = input.docs;
    const updated = await this.fileStore.updateRequirement(id, patch);
    this.publish('requirement.updated', updated);
    return updated;
  }

  /** 关联文档（去重追加） */
  async addDoc(id: string, docPath: string): Promise<RequirementData> {
    const existing = await this.fileStore.getRequirement(id);
    if (!existing) throw new Error(`Requirement not found: ${id}`);
    const docs = [...new Set([...(existing.docs ?? []), docPath])];
    return this.update(id, { docs });
  }

  /**
   * 全链路数据：需求 + 其 WorkUnit 摘要列表（id/title/status/assignee）。
   * 需求不存在返回 null。
   */
  async getChain(id: string): Promise<RequirementChain | null> {
    const requirement = await this.fileStore.getRequirement(id);
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
      })),
    };
  }

  /**
   * 状态汇总（vision §5.3）：需求的全部 WorkUnit 到达终态 → status = done。
   * 幂等；无 WorkUnit / 已 done / 已 archived 时不动作。返回是否发生了汇总。
   */
  async maybeRollUpToDone(reqId: string): Promise<boolean> {
    const requirement = await this.fileStore.getRequirement(reqId);
    if (!requirement || requirement.status === 'done' || requirement.status === 'archived') return false;
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
