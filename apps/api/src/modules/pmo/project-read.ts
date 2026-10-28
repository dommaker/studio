/** PMO 项目只读适配器与纯投影；不得加载频道、WorkUnit 或发布编排。 */
import { projectRepository } from './project-repository.js';
import {
  resolveDeliveries,
  resolveDeliveryPolicy,
  type DeliveryLeg,
} from './model.js';

/**
 * WU→腿归属：workspaceRoot/worktreeBaseRepo 命中 gitRepo，或 pmoBranch 命中 branch。
 * 两侧非空才比较；非法/空 metadata 按无命中处理。
 */
export function matchWuToLeg(metadata: string | null | undefined, leg: DeliveryLeg): boolean {
  let meta: { workspaceRoot?: unknown; worktreeBaseRepo?: unknown; pmoBranch?: unknown } = {};
  if (metadata) {
    try {
      const parsed: unknown = JSON.parse(metadata);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) meta = parsed;
    } catch { /* 无有效 metadata = 无命中 */ }
  }
  if (leg.gitRepo) {
    if (meta.workspaceRoot === leg.gitRepo) return true;
    if (meta.worktreeBaseRepo === leg.gitRepo) return true;
  }
  if (leg.branch && meta.pmoBranch === leg.branch) return true;
  return false;
}

export const projectRead = {
  get: projectRepository.get,
  getByReqAlias: projectRepository.getByReqAlias,
  getByPmoNumber: projectRepository.getByPmoNumber,
  findChoreProject: projectRepository.findChoreProject,
  list: projectRepository.list,
  resolveDeliveries,
  resolveDeliveryPolicy,
  matchWuToLeg,
};
