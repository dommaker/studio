import type { FileStore } from '@dommaker/studio-shared';
import { treeTokenReportSchema, type TreeTokenReport } from '@dommaker/studio-contract';
import type { WorkUnitData } from './workunit-crud.js';
import type { WorkUnitMetadata } from './workunit.types.js';
import type { WorkUnitListOptions, WorkUnitQuery } from './workunit-query.js';
import { ConfirmPayloadError } from './confirm-payload.js';
import { buildStatusById, resolveClaimable } from './wu-dependencies.js';
import { parseWuMetadata } from './wu-metadata.js';
import {
  workUnitPort,
  type WorkUnitPlanRulingItem,
  type WorkUnitReadPort,
  type WorkUnitReviewPort,
} from './workunit-ports.js';

export type WorkUnitApplicationErrorCode =
  | 'NOT_FOUND'
  | 'NOT_BLOCKED'
  | 'NO_PENDING_RULING'
  | 'INVALID_RULING'
  | 'NO_CHANNEL'
  | 'INVALID_INPUT';

export class WorkUnitApplicationError extends Error {
  constructor(readonly code: WorkUnitApplicationErrorCode, message: string) {
    super(message);
    this.name = 'WorkUnitApplicationError';
  }
}

export interface WorkUnitApplicationDeps {
  service: Pick<WorkUnitQuery, 'getById' | 'list'>;
  fileStore: FileStore;
  read?: WorkUnitReadPort;
  review?: WorkUnitReviewPort;
}

export async function getRequiredWorkUnit(id: string, service: Pick<WorkUnitQuery, 'getById'>): Promise<WorkUnitData> {
  const wu = await service.getById(id);
  if (!wu) throw new WorkUnitApplicationError('NOT_FOUND', `WorkUnit ${id} not found`);
  return wu;
}

/** plan 确认的 PMO 腿域校验；路由只负责调用与既有 400 映射。 */
export async function validatePlanConfirmation(
  workUnit: WorkUnitData,
  tasks: NonNullable<WorkUnitMetadata['analysisTaskDetails']>,
  deps: Pick<WorkUnitApplicationDeps, 'review'> = {},
): Promise<void> {
  const review = deps.review ?? await workUnitPort('review');
  try {
    await review.validatePlanConfirm(workUnit, tasks);
  } catch (error) {
    if (review.isPlanTaskLegError(error)) throw new ConfirmPayloadError((error as Error).message);
    throw error;
  }
}

export async function listClaimableWorkUnits(
  options: WorkUnitListOptions,
  deps: WorkUnitApplicationDeps,
): Promise<{ data: Array<WorkUnitData & { claimable: boolean }>; total: number }> {
  const result = await deps.service.list(options);
  // 仅当本页含 unassigned 行才读 index 做依赖判定；其余行 claimable 恒 false。
  const statusById = result.data.some(w => w.status === 'unassigned')
    ? buildStatusById(await deps.fileStore.getIndex())
    : new Map<string, string>();
  return {
    data: result.data.map(w => ({ ...w, claimable: resolveClaimable(w, statusById) })),
    total: result.total,
  };
}

export async function getWorkUnitTreeTokens(id: string, deps: WorkUnitApplicationDeps): Promise<TreeTokenReport> {
  const wu = await getRequiredWorkUnit(id, deps.service);
  const meta = parseWuMetadata(wu.metadata);
  const rootId = meta.collab?.rootId ?? wu.id;
  const read = deps.read ?? await workUnitPort('read');
  const parsed = treeTokenReportSchema.safeParse(await read.aggregateTreeTokens(rootId, deps.fileStore));
  if (!parsed.success) throw new Error('Invalid tree token report from WorkUnit read port');
  return parsed.data;
}

export async function submitPlanRuling(
  id: string,
  rawItems: unknown,
  deps: WorkUnitApplicationDeps,
): Promise<WorkUnitData> {
  const review = deps.review ?? await workUnitPort('review');
  try {
    const wu = await getRequiredWorkUnit(id, deps.service);
    if (wu.status !== 'blocked') {
      throw new WorkUnitApplicationError('NOT_BLOCKED', `WorkUnit 当前状态为 ${wu.status}，仅 blocked（裁决轮挂起）可提交裁决`);
    }
    const meta = parseWuMetadata(wu.metadata);
    if (!Array.isArray(meta.planRulings) || meta.planRulings.length === 0) {
      throw new WorkUnitApplicationError('NO_PENDING_RULING', '该任务无待裁的裁决轮（planRulings 为空）');
    }
    const items = review.validateRulingItems(rawItems) as WorkUnitPlanRulingItem[];
    return await review.applyPlanRuling(id, items, deps.fileStore);
  } catch (error) {
    if (review.isPlanRulingError(error)) {
      throw new WorkUnitApplicationError('INVALID_RULING', (error as Error).message);
    }
    throw error;
  }
}
