/** PMO 项目只读适配器与纯投影；不得加载频道、WorkUnit 或发布编排。 */
import { projectRepository } from './project-repository.js';
import {
  resolveDeliveries,
  resolveDeliveryPolicy,
  type DeliveryLeg,
} from './model.js';

/**
 * WU→腿归属：repo 明示时按 workspaceRoot/worktreeBaseRepo 命中 gitRepo，pmoBranch 同时存在须一致；
 * 未明示 repo 才只按 pmoBranch 命中 branch。两侧非空才比较；非法/空 metadata 按无命中处理。
 */
export function matchWuToLeg(metadata: string | null | undefined, leg: Pick<DeliveryLeg, 'gitRepo' | 'branch'>): boolean {
  let meta: { workspaceRoot?: unknown; worktreeBaseRepo?: unknown; pmoBranch?: unknown } = {};
  if (metadata) {
    try {
      const parsed: unknown = JSON.parse(metadata);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) meta = parsed;
    } catch { /* 无有效 metadata = 无命中 */ }
  }
  const hasRepoScope = (typeof meta.workspaceRoot === 'string' && meta.workspaceRoot.length > 0)
    || (typeof meta.worktreeBaseRepo === 'string' && meta.worktreeBaseRepo.length > 0);
  if (hasRepoScope) {
    // 多仓可共用同名 PMO 分支：明示 repo 后不再用 branch 跨仓兜底。
    const repoMatches = Boolean(leg.gitRepo) && (meta.workspaceRoot === leg.gitRepo || meta.worktreeBaseRepo === leg.gitRepo);
    const branchConflicts = typeof meta.pmoBranch === 'string' && meta.pmoBranch.length > 0 && meta.pmoBranch !== leg.branch;
    return repoMatches && !branchConflicts;
  }
  return Boolean(leg.branch && meta.pmoBranch === leg.branch);
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
