/**
 * 执行目录解析段（#668 自 agent-loop.ts 抽出，行为一字不改）：
 * agentStep（执行 cwd 决策）与 recordResult（提交守卫/自动验证 git cwd）共用的
 * 三条解析规则。deps 注入 WU 查询（AgentLoop 侧传 workUnitService.getById），
 * 模块本身零状态、可纯输入驱动单测（同 completion-gates 可测试性契约）。
 */
import type { WorkUnitData, WorkUnitMetadata } from '../workunit/index.js';
import { parseWuMetadata } from '../workunit/index.js';
import { CODE_WORKTREE_TYPES } from './wu-verification.js';

/** 父 WU 查询依赖（生产 = workUnitService.getById；测试 = 伪函数） */
export interface ExecutionCwdDeps {
  getWuById: (wuId: string) => Promise<WorkUnitData | null | undefined>;
}

/**
 * B3a 归属链：执行根目录解析 — 唯一来源是 metadata.workspaceRoot
 * （Requirement→PMO gitRepo / 文件引用 / 频道默认工程 / 人工回复绑定的直接路径）。
 * #481：wu.workspaceId 不再参与 cwd 决策（F6「按 workspaceId 查 workspace 记录」
 * 旧路径已退役——记录的 root 是启动时一次性抄件，退出执行面）。
 */
export function resolveExecutionWorkspaceRoot(metadata: WorkUnitMetadata): string | null {
  if (typeof metadata.workspaceRoot === 'string' && metadata.workspaceRoot.length > 0) {
    return metadata.workspaceRoot;
  }
  return null;
}

/**
 * B3b-i: review WU 继承父 WU 的 worktree 路径（评审在父 worktree 里执行，能看到 diff）。
 * 父缺失/无 worktreePath/读取失败 → null（维持现状）。
 */
export async function resolveParentWorktreePath(wu: WorkUnitData, deps: ExecutionCwdDeps): Promise<string | null> {
  if (!wu.parentId) return null;
  try {
    const parent = await deps.getWuById(wu.parentId);
    const parentMeta: WorkUnitMetadata = parseWuMetadata(parent?.metadata);
    return typeof parentMeta.worktreePath === 'string' && parentMeta.worktreePath.length > 0
      ? parentMeta.worktreePath
      : null;
  } catch {
    return null;
  }
}

/**
 * B3b-i: 提交守卫/自动验证的 git cwd 解析（recordResult 侧只读消费，不创建）。
 * 代码类 WU 有专属 worktree → 在 worktree 下跑 git status；
 * review WU → 父 WU worktree；否则回退 B3a 的共享根解析（#481 起仅 metadata.workspaceRoot）。
 * #157（T6）：挂 worktree 的 analysis（原型单）同样解析到 metadata.worktreePath ——
 * 未 commit 打回守卫作用于原型 worktree；无落档的普通 analysis 走共享根解析，行为不变。
 */
export async function resolveExecutionCwd(
  wu: WorkUnitData,
  metadata: WorkUnitMetadata,
  deps: ExecutionCwdDeps,
): Promise<string | null> {
  if ((CODE_WORKTREE_TYPES.has(wu.type) || wu.type === 'analysis')
    && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
    return metadata.worktreePath;
  }
  if (wu.type === 'review') {
    const parentWorktree = await resolveParentWorktreePath(wu, deps);
    if (parentWorktree) return parentWorktree;
  }
  return resolveExecutionWorkspaceRoot(metadata);
}
