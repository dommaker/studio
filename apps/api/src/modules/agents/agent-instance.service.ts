/**
 * AgentInstance Service — RuntimeInstance CRUD
 *
 * AS-026: AC-1 CRUD API
 * Storage: FileStore (迁移步骤 3)
 */

import { FileStore, type RuntimeStateData } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit/workunit.service.js';

const VALID_STATUSES = ['idle', 'active', 'terminated'] as const;

export interface CreateInstanceInput {
  roleId: string;
  sessionId?: string;
  metadata?: string;
}

export interface UpdateInstanceInput {
  status?: string;
  currentWorkUnitId?: string | null;
  sessionId?: string | null;
  metadata?: string | null;
}

export class AgentInstanceService {
  private fileStore: FileStore;
  private workUnitService: WorkUnitService;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
    this.workUnitService = new WorkUnitService(this.fileStore);
  }

  async create(input: CreateInstanceInput): Promise<RuntimeStateData> {
    const now = new Date().toISOString();
    const data: RuntimeStateData = {
      id: crypto.randomUUID(),
      roleId: input.roleId,
      sessionId: input.sessionId ?? null,
      status: 'idle',
      currentWorkUnitId: null,
      startedAt: now,
      terminatedAt: null,
      lastHeartbeat: null,
      metadata: input.metadata ?? null,
    };
    await this.fileStore.createState(data.id, data);
    return data;
  }

  async getById(id: string): Promise<RuntimeStateData | null> {
    return this.fileStore.getState(id);
  }

  async list(options?: { status?: string; page?: number; limit?: number }): Promise<{
    data: RuntimeStateData[];
    total: number;
  }> {
    const { status, page = 1, limit = 20 } = options ?? {};
    let states = await this.fileStore.listStates();

    if (status) {
      states = states.filter(s => s.status === status);
    }

    // 按 startedAt 降序
    states.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    const total = states.length;
    const start = (page - 1) * limit;
    const data = states.slice(start, start + limit);

    return { data, total };
  }

  /**
   * 强制停止实例（2026-07 PMO-flow UX §4 语义修正）：
   *   1. unclaim 当前 WorkUnit；
   *   2. 该 WU 置 blocked 转人工（blockForManualRelease）——blocked 不在 loop 认领集合内，
   *      避免活 loop ≤15s 重新认领同一 WU 导致释放无效（旧行为只 unclaim）；
   *   3. 实例状态置 terminated。
   * WU 侧操作为 best-effort（WU 缺失/读写失败不阻断实例终止）。
   */
  async terminate(id: string): Promise<RuntimeStateData> {
    const instance = await this.fileStore.getState(id);
    if (!instance) throw new Error('Instance not found');

    // Unclaim current WorkUnit if any, then block it for manual handling (best-effort)
    if (instance.currentWorkUnitId) {
      const workUnitId = instance.currentWorkUnitId;
      await this.workUnitService.unclaim(workUnitId)
        .then(() => this.workUnitService.blockForManualRelease(workUnitId, `terminate instance ${id}`))
        .catch(() => {});
    }

    const now = new Date().toISOString();
    await this.fileStore.updateState(id, {
      status: 'terminated',
      terminatedAt: now,
      currentWorkUnitId: null,
    });

    const updated = await this.fileStore.getState(id);
    if (!updated) throw new Error('Instance not found after update');
    return updated;
  }

  async update(id: string, input: UpdateInstanceInput): Promise<RuntimeStateData> {
    if (input.status !== undefined && !(VALID_STATUSES as readonly string[]).includes(input.status)) {
      throw new Error(`Invalid status: ${input.status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const patch: Partial<RuntimeStateData> = {};
    if (input.status !== undefined) patch.status = input.status;
    if (input.currentWorkUnitId !== undefined) patch.currentWorkUnitId = input.currentWorkUnitId;
    if (input.sessionId !== undefined) patch.sessionId = input.sessionId;
    if (input.metadata !== undefined) patch.metadata = input.metadata;

    await this.fileStore.updateState(id, patch);
    const updated = await this.fileStore.getState(id);
    if (!updated) throw new Error(`Instance not found: ${id}`);
    return updated;
  }
}
