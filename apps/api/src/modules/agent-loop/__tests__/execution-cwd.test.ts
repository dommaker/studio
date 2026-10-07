// execution-cwd 单测（#668 自 agent-loop.ts 抽出的执行目录解析段）：
// resolveExecutionWorkspaceRoot（#481 唯一来源 = metadata.workspaceRoot）/
// resolveParentWorktreePath（B3b-i review 继承父 worktree）/
// resolveExecutionCwd（收口守卫侧 git cwd 解析）。
// 纯函数 + 注入伪依赖（getWuById），无 vi.mock 模块工厂（同 completion-gates 可测试性契约）。
import { describe, it, expect, vi } from 'vitest';
import {
  resolveExecutionWorkspaceRoot,
  resolveParentWorktreePath,
  resolveExecutionCwd,
  type ExecutionCwdDeps,
} from '../execution-cwd';
import type { WorkUnitData } from '../../workunit/workunit.service.js';

function makeWu(overrides: Partial<WorkUnitData> = {}): WorkUnitData {
  return {
    id: 'wu-1', parentId: null, type: 'task', scope: '实现功能', assigneeId: 'instance-1',
    status: 'active', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, workspaceId: null, metadata: null,
    createdAt: new Date(), updatedAt: new Date(), claimedAt: null, completedAt: null,
    ...overrides,
  };
}

function makeDeps(getWuById: ExecutionCwdDeps['getWuById'] = vi.fn().mockResolvedValue(null)): ExecutionCwdDeps {
  return { getWuById };
}

describe('resolveExecutionWorkspaceRoot（#481：唯一来源 metadata.workspaceRoot）', () => {
  it('workspaceRoot 非空 → 原样返回', () => {
    expect(resolveExecutionWorkspaceRoot({ workspaceRoot: '/repo/x' })).toBe('/repo/x');
  });
  it('workspaceRoot 空串/缺失 → null', () => {
    expect(resolveExecutionWorkspaceRoot({ workspaceRoot: '' })).toBeNull();
    expect(resolveExecutionWorkspaceRoot({})).toBeNull();
  });
});

describe('resolveParentWorktreePath（B3b-i：review 继承父 WU worktree）', () => {
  it('无 parentId → null（不查库）', async () => {
    const getWuById = vi.fn();
    expect(await resolveParentWorktreePath(makeWu(), makeDeps(getWuById))).toBeNull();
    expect(getWuById).not.toHaveBeenCalled();
  });
  it('父 WU 不存在 / metadata 无 worktreePath / 空串 → null', async () => {
    expect(await resolveParentWorktreePath(
      makeWu({ parentId: 'wu-p' }), makeDeps(vi.fn().mockResolvedValue(null)),
    )).toBeNull();
    expect(await resolveParentWorktreePath(
      makeWu({ parentId: 'wu-p' }), makeDeps(vi.fn().mockResolvedValue(makeWu({ id: 'wu-p' }))),
    )).toBeNull();
    expect(await resolveParentWorktreePath(
      makeWu({ parentId: 'wu-p' }),
      makeDeps(vi.fn().mockResolvedValue(makeWu({ id: 'wu-p', metadata: JSON.stringify({ worktreePath: '' }) }))),
    )).toBeNull();
  });
  it('父 WU 有 worktreePath → 返回之', async () => {
    const parent = makeWu({ id: 'wu-p', metadata: JSON.stringify({ worktreePath: '/wt/parent' }) });
    expect(await resolveParentWorktreePath(makeWu({ parentId: 'wu-p' }), makeDeps(vi.fn().mockResolvedValue(parent))))
      .toBe('/wt/parent');
  });
  it('读父 WU 抛错 → null（维持现状，不阻断执行）', async () => {
    expect(await resolveParentWorktreePath(
      makeWu({ parentId: 'wu-p' }), makeDeps(vi.fn().mockRejectedValue(new Error('io'))),
    )).toBeNull();
  });
});

describe('resolveExecutionCwd（提交守卫/自动验证的 git cwd 解析）', () => {
  it('代码类 WU（task）+ 已建 worktree → worktreePath', async () => {
    const getWuById = vi.fn();
    expect(await resolveExecutionCwd(makeWu({ type: 'task' }), { worktreePath: '/wt/wu-1' }, makeDeps(getWuById)))
      .toBe('/wt/wu-1');
    expect(getWuById).not.toHaveBeenCalled();
  });
  it('analysis 原型单 + 已建 worktree → worktreePath（#157）', async () => {
    expect(await resolveExecutionCwd(makeWu({ type: 'analysis' }), { worktreePath: '/wt/proto' }, makeDeps()))
      .toBe('/wt/proto');
  });
  it('代码类 WU 无 worktreePath → 回退 workspaceRoot', async () => {
    expect(await resolveExecutionCwd(makeWu({ type: 'bug' }), { workspaceRoot: '/repo' }, makeDeps()))
      .toBe('/repo');
  });
  it('review WU → 父 worktree 优先；父无 → 回退 workspaceRoot', async () => {
    const parent = makeWu({ id: 'wu-p', metadata: JSON.stringify({ worktreePath: '/wt/parent' }) });
    expect(await resolveExecutionCwd(
      makeWu({ type: 'review', parentId: 'wu-p' }), {}, makeDeps(vi.fn().mockResolvedValue(parent)),
    )).toBe('/wt/parent');
    expect(await resolveExecutionCwd(
      makeWu({ type: 'review', parentId: null }), { workspaceRoot: '/repo' }, makeDeps(),
    )).toBe('/repo');
  });
  it('非代码非 review（decision）→ workspaceRoot', async () => {
    expect(await resolveExecutionCwd(makeWu({ type: 'decision' }), { workspaceRoot: '/repo' }, makeDeps()))
      .toBe('/repo');
    expect(await resolveExecutionCwd(makeWu({ type: 'decision' }), {}, makeDeps())).toBeNull();
  });
});
