/**
 * AgentInstance Service — RuntimeInstance 生命周期 + 实例态聚合查询
 *
 * AS-026: AC-1 CRUD API
 * Storage: FileStore (迁移步骤 3)
 *
 * terminate 编排（unclaim + blockForManualRelease）有两个生产调用方：
 * agent-instance.routes（管理端强制停止）与 instance-timeout-scan（心跳超时回收）。
 * summarizeRoleStates：isOnline / 每角色最新 error 的聚合查询（原 agent-profile
 * list() 内联 fan-out 收口），存活窗口 INSTANCE_ALIVE_TIMEOUT_MS 单源，
 * instance-timeout-scan 的 AGENT_TIMEOUT_MS 与之同源。
 */

import { FileStore, type RuntimeStateData } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit/workunit.service.js';

const VALID_STATUSES = ['idle', 'active', 'terminated'] as const;

/** 实例存活判定窗口：心跳/启动时间距今超过该值即离线。scan 超时阈值与在线判定共用。 */
export const INSTANCE_ALIVE_TIMEOUT_MS = 5 * 60 * 1000;

/** F2：按角色聚合的最新启动失败（status=error 且有 lastError） */
export interface RoleInstanceError {
  lastError: string;
  lastErrorAt: string | null;
}

export interface RoleInstanceStateSummary {
  /** 在线角色 id 集合：status idle/active 且心跳新鲜（无心跳时按 startedAt 宽限） */
  onlineRoleIds: Set<string>;
  latestErrorByRole: Map<string, RoleInstanceError>;
}

/**
 * 按角色聚合 RuntimeState 查询：一次 listStates 同时产出在线判定集与最新 error，
 * 调用方（agent-profile list）不再自己全量扫描、自己复制 5min 阈值。
 */
export async function summarizeRoleStates(
  fileStore: FileStore,
  roleIds: string[],
): Promise<RoleInstanceStateSummary> {
  const onlineThreshold = Date.now() - INSTANCE_ALIVE_TIMEOUT_MS;
  const wanted = new Set(roleIds);
  const allStates = await fileStore.listStates();

  const onlineRoleIds = new Set<string>();
  const latestErrorByRole = new Map<string, RoleInstanceError>();
  for (const s of allStates) {
    if (!wanted.has(s.roleId)) continue;

    if (
      (s.status === 'active' || s.status === 'idle') &&
      (s.lastHeartbeat
        ? new Date(s.lastHeartbeat).getTime() >= onlineThreshold
        : new Date(s.startedAt).getTime() >= onlineThreshold)
    ) {
      onlineRoleIds.add(s.roleId);
    }

    if (s.status === 'error' && s.lastError) {
      const prev = latestErrorByRole.get(s.roleId);
      if (!prev || (s.lastErrorAt ?? '') > (prev.lastErrorAt ?? '')) {
        latestErrorByRole.set(s.roleId, { lastError: s.lastError, lastErrorAt: s.lastErrorAt ?? null });
      }
    }
  }
  return { onlineRoleIds, latestErrorByRole };
}

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
