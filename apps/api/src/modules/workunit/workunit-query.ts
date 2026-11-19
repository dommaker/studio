/**
 * WorkUnit 查询派生层 —— WorkUnitQueryService（#672 自 workunit.service.ts 拆分，纯代码移动）。
 *
 * 本层：只读查询与派生——getById / list（多维过滤 + 分页）/ lastDoneByAssignee（#387 批量聚合）。
 * 写路径不在本层：CRUD/Claim 在 workunit-crud.ts，状态机迁移在 workunit-lifecycle.ts，
 * 评审验收在 workunit-review.ts；ARCH-05 起四类用例经构造注入组合，无继承。
 */

import { parseWuPmoId, type FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { snapshotToData, type WorkUnitData } from './workunit-crud.js';
import { workUnitPort } from './workunit-ports.js';
import { getStore } from '../../core/store.js';

export interface WorkUnitQuery {
  getById(id: string): Promise<WorkUnitData | null>;
  list(options?: WorkUnitListOptions): Promise<{ data: WorkUnitData[]; total: number }>;
  lastDoneByAssignee(assigneeIds: readonly string[]): Promise<Record<string, WorkUnitData | null>>;
}

export interface WorkUnitListOptions {
  type?: string;
  status?: string;
  assigneeId?: string;
  channelId?: string;
  parentId?: string;
  failureType?: string;
  timedOutBefore?: Date;
  attributed?: boolean;
  projectId?: string;
  q?: string;
  page?: number;
  limit?: number;
}

export class WorkUnitQueryService implements WorkUnitQuery {
  constructor(private readonly fileStore: FileStore = getStore()) {}

  /**
   * Get a WorkUnit by id. Returns null if not found.
   */
  async getById(id: string): Promise<WorkUnitData | null> {
    const found = (await this.fileStore.getIndex({ id }))[0];
    return found ? snapshotToData(found) : null;
  }

  /**
   * List WorkUnits with optional filters and pagination.
   */
  async list(options?: WorkUnitListOptions): Promise<{ data: WorkUnitData[]; total: number }> {
    const { type, status, assigneeId, channelId, parentId, failureType, timedOutBefore, attributed, projectId, q, page = 1, limit = 20 } = options ?? {};

    let snapshots = await this.fileStore.getIndex();

    // In-memory filter
    if (type) snapshots = snapshots.filter(s => s.type === type);
    if (status) snapshots = snapshots.filter(s => s.status === status);
    // ADR 2026-09-23-role-form-module 决策 7（#630）：assigneeId 或 assigneeRoleId 任一命中。
    // claim 会把 assigneeId 改写为实例 id（认领快照留在 assigneeRoleId），只认 assigneeId
    // 会漏掉正在执行的那批——角色删除确认框的在途清单依赖本口径。
    if (assigneeId) snapshots = snapshots.filter(s => s.assigneeId === assigneeId || s.assigneeRoleId === assigneeId);
    if (channelId) snapshots = snapshots.filter(s => s.channelId === channelId);
    if (parentId) snapshots = snapshots.filter(s => s.parentId === parentId);
    if (failureType) snapshots = snapshots.filter(s => s.failureType === failureType);
    if (timedOutBefore) {
      const cutoff = timedOutBefore.getTime();
      snapshots = snapshots.filter(s => s.timeoutAt && new Date(s.timeoutAt).getTime() <= cutoff);
    }
    if (attributed !== undefined) {
      // #428：已归属 = 有 reqId 或归因戳（pmoId）非 null
      snapshots = snapshots.filter(s => (!!s.reqId || parseWuPmoId(s.metadata) !== null) === attributed);
    }
    if (projectId) {
      // ARCH-02：归属口径仍由 PMO 实现提供，WorkUnit 只经 project-read 端口消费。
      snapshots = await (await workUnitPort('projectRead')).selectProjectSnapshots(projectId, this.fileStore, snapshots);
    }
    if (q) {
      const needle = q.toLowerCase();
      snapshots = snapshots.filter(s => s.scope.toLowerCase().includes(needle));
    }

    // Sort by createdAt desc
    snapshots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = snapshots.length;

    // Paginate
    const start = (page - 1) * limit;
    const paged = snapshots.slice(start, start + limit);

    return { data: paged.map(snapshotToData), total };
  }

  /**
   * #387 批量聚合：每 assignee 最近一条完成 WU（done/completed，按 completedAt ?? updatedAt
   * 降序取首条；无完成记录 → null）。一次索引读取替掉 roster 空闲卡逐实例
   * GET /workunits?assigneeId= 的 N+1。口径注：全量扫描，不沿用前端 limit=20 先截后滤
   * （那会漏掉 20 条之外更早的完成单）。
   */
  async lastDoneByAssignee(assigneeIds: readonly string[]): Promise<Record<string, WorkUnitData | null>> {
    const snapshots = await this.fileStore.getIndex();
    const lastByAssignee = new Map<string, WorkUnitSnapshot>();
    for (const s of snapshots) {
      if (!s.assigneeId || (s.status !== 'done' && s.status !== 'completed')) continue;
      if (!assigneeIds.includes(s.assigneeId)) continue;
      const cur = lastByAssignee.get(s.assigneeId);
      if (!cur || (s.completedAt ?? s.updatedAt).localeCompare(cur.completedAt ?? cur.updatedAt) > 0) {
        lastByAssignee.set(s.assigneeId, s);
      }
    }
    const result: Record<string, WorkUnitData | null> = {};
    for (const id of assigneeIds) {
      const found = lastByAssignee.get(id);
      result[id] = found ? snapshotToData(found) : null;
    }
    return result;
  }
}
