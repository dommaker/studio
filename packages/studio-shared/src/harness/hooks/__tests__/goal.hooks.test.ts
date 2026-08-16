/**
 * goal.hooks — 采样约束检查（A1：runtime/cache.ts 退役后直用 harness CheckCache 采样）
 *
 * 行为钉：beforeGoalCreate 对同一 projectPath 每 3 次执行 1 次完整约束检查
 * （第 1/4 次采样，其余复用缓存），检查上下文透传 operation/taskDescription/projectPath。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCheckBeforeExecution } = vi.hoisted(() => ({
  mockCheckBeforeExecution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return { ...actual, checkBeforeExecution: mockCheckBeforeExecution };
});

import { beforeGoalCreate } from '../goal.hooks';

describe('beforeGoalCreate — 采样约束检查（CheckCache）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HARNESS_HOOK_DISABLE = '';
  });

  afterEach(() => {
    delete process.env.HARNESS_HOOK_DISABLE;
  });

  it('每 3 次执行 1 次完整检查：连续 5 次调用 → checkBeforeExecution 仅执行 2 次（第 1/4 次采样轮）', async () => {
    for (let i = 0; i < 5; i++) {
      await beforeGoalCreate({ operation: 'goal_creation', taskDescription: '建目标', projectPath: '/repo' });
    }

    expect(mockCheckBeforeExecution).toHaveBeenCalledTimes(2);
  });

  it('检查上下文透传 operation/taskDescription/projectPath（operation 固定 goal_creation）', async () => {
    await beforeGoalCreate({ operation: 'anything', taskDescription: '任务描述', projectPath: '/p' });

    expect(mockCheckBeforeExecution).toHaveBeenCalledWith({
      operation: 'goal_creation',
      taskDescription: '任务描述',
      projectPath: '/p',
    });
  });

  it('采样计数按 projectPath 独立：不同项目各自第 1 次都执行完整检查', async () => {
    await beforeGoalCreate({ operation: 'goal_creation', taskDescription: 'a', projectPath: '/p1' });
    await beforeGoalCreate({ operation: 'goal_creation', taskDescription: 'b', projectPath: '/p2' });

    expect(mockCheckBeforeExecution).toHaveBeenCalledTimes(2);
  });
});
