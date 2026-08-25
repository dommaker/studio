/**
 * WorkUnit 快照 ↔ DTO 转换层（工单 30 自 workunit.service.ts 抽出，纯搬运零逻辑变更）。
 * snapshotToData 经 workunit.service re-export 保持既有导出路径兼容（agent-loop 等消费方不变）。
 */

import type { WorkUnitSnapshot } from '@dommaker/studio-shared';
import type { CreateWorkUnitInput, UpdateWorkUnitInput, WorkUnitData } from './workunit.types.js';

// ── 转换函数 ──

export function snapshotToData(s: WorkUnitSnapshot): WorkUnitData {
  return {
    id: s.id,
    parentId: s.parentId,
    type: s.type,
    scope: s.scope,
    assigneeId: s.assigneeId,
    status: s.status,
    failureType: s.failureType,
    retryCount: s.retryCount,
    timeoutAt: s.timeoutAt ? new Date(s.timeoutAt) : null,
    channelId: s.channelId,
    projectPath: s.projectPath,
    workspaceId: s.workspaceId ?? null,
    reqId: s.reqId ?? null,
    metadata: s.metadata,
    createdAt: new Date(s.createdAt),
    updatedAt: new Date(s.updatedAt),
    claimedAt: s.claimedAt ? new Date(s.claimedAt) : null,
    completedAt: s.completedAt ? new Date(s.completedAt) : null,
    closedAt: s.closedAt ? new Date(s.closedAt) : null,
  };
}

export function inputToSnapshot(
  id: string,
  input: CreateWorkUnitInput,
  now: Date,
): WorkUnitSnapshot {
  const isoNow = now.toISOString();
  return {
    id,
    parentId: input.parentId ?? null,
    type: input.type ?? 'task',
    scope: input.scope,
    assigneeId: input.assigneeId ?? null,
    status: input.status ?? 'unassigned',
    failureType: input.failureType ?? null,
    retryCount: input.retryCount ?? 0,
    timeoutAt: input.timeoutAt?.toISOString() ?? null,
    channelId: input.channelId ?? null,
    projectPath: input.projectPath ?? null,
    workspaceId: input.workspaceId ?? null,
    reqId: input.reqId ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt: isoNow,
    updatedAt: isoNow,
    claimedAt: null,
    completedAt: input.completedAt?.toISOString() ?? null,
  };
}

export function patchSnapshot(
  existing: WorkUnitSnapshot,
  input: UpdateWorkUnitInput,
  now: Date,
): WorkUnitSnapshot {
  const isoNow = now.toISOString();
  return {
    ...existing,
    type: input.type ?? existing.type,
    scope: input.scope ?? existing.scope,
    assigneeId: input.assigneeId !== undefined ? input.assigneeId : existing.assigneeId,
    channelId: input.channelId !== undefined ? input.channelId : existing.channelId,
    parentId: input.parentId !== undefined ? input.parentId : existing.parentId,
    projectPath: input.projectPath !== undefined ? input.projectPath : existing.projectPath,
    workspaceId: input.workspaceId !== undefined ? input.workspaceId : existing.workspaceId ?? null,
    reqId: input.reqId !== undefined ? input.reqId : existing.reqId ?? null,
    failureType: input.failureType !== undefined ? input.failureType : existing.failureType,
    retryCount: input.retryCount ?? existing.retryCount,
    timeoutAt: input.timeoutAt !== undefined ? input.timeoutAt?.toISOString() ?? null : existing.timeoutAt,
    completedAt: input.completedAt !== undefined ? input.completedAt?.toISOString() ?? null : existing.completedAt,
    metadata: input.metadata !== undefined ? JSON.stringify(input.metadata) : existing.metadata,
    updatedAt: isoNow,
  };
}
