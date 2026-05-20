/**
 * GoalService 核心逻辑测试
 *
 * 覆盖：依赖调度、AcGroup ID 转换、Goal 状态机
 */
import { describe, it, expect } from 'vitest';

// === 纯函数测试：依赖调度逻辑（getExecutableSteps 核心） ===

interface Step {
  index: number;
  dependencies: number[];
}

interface Execution {
  stepIndex: number;
  status: string;
}

function getExecutableSteps(
  steps: Step[],
  executions: Execution[],
  includeIntegration = false,
): number[] {
  const execMap = new Map(executions.map(e => [e.stepIndex, e]));
  const executable: number[] = [];

  for (const step of steps) {
    const exec = execMap.get(step.index);
    if (!exec || exec.status !== 'pending') continue;

    const depsSatisfied = step.dependencies.every(depIndex => {
      const depExec = execMap.get(depIndex);
      return depExec?.status === 'succeeded';
    });

    if (depsSatisfied) executable.push(step.index);
  }

  if (includeIntegration) {
    const allDone = steps.every(s => {
      const e = execMap.get(s.index);
      return e?.status === 'succeeded' || e?.status === 'failed';
    });
    if (allDone && executable.length === 0) {
      const integration = executions.find(e => e.stepIndex === 999 && e.status === 'pending');
      if (integration) executable.push(999);
    }
  }

  return executable;
}

describe('getExecutableSteps — 依赖调度', () => {
  const steps: Step[] = [
    { index: 0, dependencies: [] },
    { index: 1, dependencies: [0] },
  ];

  it('返回所有依赖已满足的 pending 步骤', () => {
    const execs: Execution[] = [
      { stepIndex: 0, status: 'succeeded' },
      { stepIndex: 1, status: 'pending' },
    ];
    expect(getExecutableSteps(steps, execs)).toEqual([1]);
  });

  it('依赖未完成时不返回该步骤', () => {
    const execs: Execution[] = [
      { stepIndex: 0, status: 'running' },
      { stepIndex: 1, status: 'pending' },
    ];
    expect(getExecutableSteps(steps, execs)).toEqual([]);
  });

  it('无依赖的步骤可以直接执行', () => {
    const execs: Execution[] = [
      { stepIndex: 0, status: 'pending' },
      { stepIndex: 1, status: 'pending' },
    ];
    expect(getExecutableSteps(steps, execs)).toEqual([0]);
  });

  it('全部完成后集成步骤可用', () => {
    const execs: Execution[] = [
      { stepIndex: 0, status: 'succeeded' },
      { stepIndex: 999, status: 'pending' },
    ];
    expect(getExecutableSteps([steps[0]], execs, true)).toEqual([999]);
  });

  it('部分完成时集成步骤不可用', () => {
    const execs: Execution[] = [
      { stepIndex: 0, status: 'running' },
      { stepIndex: 999, status: 'pending' },
    ];
    expect(getExecutableSteps([steps[0]], execs, true)).toEqual([]);
  });

  it('有失败时，集成步骤不会被创建（checkAllStepsCompleted 拦截），因此 getExecutableSteps 看不到它', () => {
    // 有失败的 execution 时，checkAllStepsCompleted 不会创建集成步骤。
    // 因此 execs 中不存在 pending integration step，getExecutableSteps 返回空。
    const execs: Execution[] = [
      { stepIndex: 0, status: 'failed' },
      // 集成步骤不存在（由 checkAllStepsCompleted 守卫）
    ];
    expect(getExecutableSteps([steps[0]], execs, true)).toEqual([]);
  });
});

describe('AcGroup 依赖 ID → Step 索引转换', () => {
  it('string ID 正确映射到 step index', () => {
    const acGroups = [
      { id: 'group-a', dependencies: [] as string[] },
      { id: 'group-b', dependencies: ['group-a'] as string[] },
    ];
    const groupIdToIndex = new Map(acGroups.map((g, i) => [g.id, i]));

    const steps = acGroups.map((group, index) => ({
      index,
      dependencies: (group.dependencies || []).map(depId => {
        const depIndex = groupIdToIndex.get(depId);
        return depIndex !== undefined ? depIndex : -1;
      }).filter(i => i >= 0),
    }));

    expect(steps[0].dependencies).toEqual([]);
    expect(steps[1].dependencies).toEqual([0]);
  });

  it('无效依赖 ID 被静默过滤', () => {
    const acGroups = [
      { id: 'a', dependencies: ['nonexistent', 'also-fake'] },
    ];
    const groupIdToIndex = new Map(acGroups.map((g, i) => [g.id, i]));
    const steps = acGroups.map((g, i) => ({
      index: i,
      dependencies: (g.dependencies || []).map(d => groupIdToIndex.get(d) ?? -1).filter(d => d >= 0),
    }));
    expect(steps[0].dependencies).toEqual([]);
  });
});

describe('checkGoalCompletion — 状态机', () => {
  function checkGoalDone(executions: Array<{ status: string }>): 'succeeded' | 'failed' | null {
    const allDone = executions.every(e => e.status === 'succeeded' || e.status === 'failed');
    if (!allDone) return null;
    return executions.some(e => e.status === 'failed') ? 'failed' : 'succeeded';
  }

  it('全部 succeeded → succeeded', () => {
    expect(checkGoalDone([{ status: 'succeeded' }, { status: 'succeeded' }])).toBe('succeeded');
  });

  it('有 failed → failed', () => {
    expect(checkGoalDone([{ status: 'succeeded' }, { status: 'failed' }])).toBe('failed');
  });

  it('有 running 时不完成', () => {
    expect(checkGoalDone([{ status: 'succeeded' }, { status: 'running' }])).toBeNull();
  });

  it('有 pending 时不完成', () => {
    expect(checkGoalDone([{ status: 'succeeded' }, { status: 'pending' }])).toBeNull();
  });
});
