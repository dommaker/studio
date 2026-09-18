// 入口守卫链单测（step-guards，#541）：纯 ctx 对象 + 注入伪依赖，无 vi.mock 模块工厂、
// 不整类构造 AgentLoop（对称 completion-gates.test.ts 的可测试性契约）。
// 覆盖：四段守卫各自命中/放行、短路顺序（B2 → C3 日预算 → #162 WU 预算 → #471 plan 额度）、
// B2 副作用（留痕/关闭/频道通知）与 dep 失败容错、C3 当日只告警一次、
// WU 预算/plan 额度的 need_input 形状（waitingReason）。
import { describe, it, expect, vi } from 'vitest';
import {
  runStepGuards,
  type StepGuardDeps,
} from '../step-guards';
import { PLAN_STEP_LIMIT } from '../../../workunit/workunit.types';
import type { WorkUnitData, WorkUnitMetadata } from '../../../workunit/workunit.service.js';

function makeWu(overrides: Partial<WorkUnitData> = {}): WorkUnitData {
  return {
    id: 'wu-1', parentId: null, type: 'task', scope: '实现功能', assigneeId: 'instance-1',
    status: 'active', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, workspaceId: null, metadata: null,
    createdAt: new Date(), updatedAt: new Date(), claimedAt: null, completedAt: null,
    ...overrides,
  };
}

/** 默认伪依赖：全部守卫放行（B2 关 / 日预算充足 / 无 WU 预算 / 非 plan） */
function makeDeps(overrides: Partial<StepGuardDeps> = {}): StepGuardDeps & {
  updateWuMetadata: ReturnType<typeof vi.fn>;
  closeWu: ReturnType<typeof vi.fn>;
  postNotice: ReturnType<typeof vi.fn>;
  eventsFilePath: ReturnType<typeof vi.fn>;
  testWuGuardEnabled: ReturnType<typeof vi.fn>;
  isTestLikeWorkUnit: ReturnType<typeof vi.fn>;
  tokenBudgetGuardEnabled: ReturnType<typeof vi.fn>;
  resolveDailyTokenBudget: ReturnType<typeof vi.fn>;
  getDailyTokenUsage: ReturnType<typeof vi.fn>;
  notifyBudgetTripped: ReturnType<typeof vi.fn>;
} {
  return {
    updateWuMetadata: vi.fn().mockResolvedValue(undefined),
    closeWu: vi.fn().mockResolvedValue(undefined),
    postNotice: vi.fn().mockResolvedValue(undefined),
    eventsFilePath: vi.fn().mockReturnValue('/tmp/studio-events.jsonl'),
    testWuGuardEnabled: vi.fn().mockReturnValue(false),
    isTestLikeWorkUnit: vi.fn().mockReturnValue(false),
    tokenBudgetGuardEnabled: vi.fn().mockReturnValue(false),
    resolveDailyTokenBudget: vi.fn().mockReturnValue(2_000_000),
    getDailyTokenUsage: vi.fn().mockResolvedValue({ dateKey: '2026-09-15', usedTokens: 0, notified: false }),
    notifyBudgetTripped: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as ReturnType<typeof makeDeps>;
}

describe('step-guards: B2 测试特征 WU 守卫', () => {
  it('命中：skipped + 留痕（testWorkUnitGuard/blockReason）+ 关闭 + 频道通知', async () => {
    const deps = makeDeps({
      testWuGuardEnabled: vi.fn().mockReturnValue(true),
      isTestLikeWorkUnit: vi.fn().mockReturnValue(true),
    });
    const metadata: WorkUnitMetadata = { triggerId: 't-1' };
    const out = await runStepGuards({ wu: makeWu({ scope: 'tree-tokens test' }), metadata }, deps);

    expect(out.result).toEqual({ action: 'skipped', summary: '' });
    expect(deps.updateWuMetadata).toHaveBeenCalledTimes(1);
    const [wuId, written] = deps.updateWuMetadata.mock.calls[0] as [string, WorkUnitMetadata];
    expect(wuId).toBe('wu-1');
    expect(written.triggerId).toBe('t-1'); // 原 metadata 字段保留
    expect(written.testWorkUnitGuard).toBe(true);
    expect(written.blockReason).toContain('test-wu-guard');
    expect(deps.closeWu).toHaveBeenCalledWith('wu-1');
    expect(deps.postNotice).toHaveBeenCalledTimes(1);
    expect((deps.postNotice.mock.calls[0] as [string, string])[1]).toContain('测试特征任务');
  });

  it('守卫关闭或非测试特征：放行（result=null），零副作用', async () => {
    for (const deps of [
      makeDeps({ testWuGuardEnabled: vi.fn().mockReturnValue(false), isTestLikeWorkUnit: vi.fn().mockReturnValue(true) }),
      makeDeps({ testWuGuardEnabled: vi.fn().mockReturnValue(true), isTestLikeWorkUnit: vi.fn().mockReturnValue(false) }),
    ]) {
      const out = await runStepGuards({ wu: makeWu(), metadata: {} }, deps);
      expect(out.result).toBeNull();
      expect(deps.updateWuMetadata).not.toHaveBeenCalled();
      expect(deps.closeWu).not.toHaveBeenCalled();
      expect(deps.postNotice).not.toHaveBeenCalled();
    }
  });

  it('WU 已 closed：不再重复关闭，仍留痕 + 通知', async () => {
    const deps = makeDeps({
      testWuGuardEnabled: vi.fn().mockReturnValue(true),
      isTestLikeWorkUnit: vi.fn().mockReturnValue(true),
    });
    const out = await runStepGuards({ wu: makeWu({ status: 'closed' }), metadata: {} }, deps);

    expect(out.result?.action).toBe('skipped');
    expect(deps.closeWu).not.toHaveBeenCalled();
    expect(deps.updateWuMetadata).toHaveBeenCalledTimes(1);
    expect(deps.postNotice).toHaveBeenCalledTimes(1);
  });

  it('副作用 dep 失败（写盘/关闭 reject）：容错继续，仍返回 skipped', async () => {
    const deps = makeDeps({
      testWuGuardEnabled: vi.fn().mockReturnValue(true),
      isTestLikeWorkUnit: vi.fn().mockReturnValue(true),
      updateWuMetadata: vi.fn().mockRejectedValue(new Error('disk full')),
      closeWu: vi.fn().mockRejectedValue(new Error('transition failed')),
    });
    const out = await runStepGuards({ wu: makeWu(), metadata: {} }, deps);

    expect(out.result?.action).toBe('skipped');
    expect(deps.closeWu).toHaveBeenCalled(); // 写盘失败不阻断关闭尝试
    expect(deps.postNotice).toHaveBeenCalledTimes(1);
  });
});

describe('step-guards: C3 日 token 预算熔断', () => {
  const guardOn = (usedTokens: number, notified = false) => makeDeps({
    tokenBudgetGuardEnabled: vi.fn().mockReturnValue(true),
    resolveDailyTokenBudget: vi.fn().mockReturnValue(2_000_000),
    getDailyTokenUsage: vi.fn().mockResolvedValue({ dateKey: '2026-09-15', usedTokens, notified }),
  });

  it('当日已耗 ≥ 预算：need_input 挂起 + 首次告警（notifyBudgetTripped）', async () => {
    const deps = guardOn(2_000_000);
    const out = await runStepGuards({ wu: makeWu(), metadata: {} }, deps);

    expect(out.result?.action).toBe('need_input');
    expect(out.result?.summary).toContain('预算已熔断');
    expect(deps.getDailyTokenUsage).toHaveBeenCalledWith({ eventsFile: '/tmp/studio-events.jsonl' });
    expect(deps.notifyBudgetTripped).toHaveBeenCalledTimes(1);
    expect(deps.notifyBudgetTripped).toHaveBeenCalledWith({
      eventsFile: '/tmp/studio-events.jsonl', usedTokens: 2_000_000, budget: 2_000_000,
    });
  });

  it('当日已告警过（notified=true）：仍挂起但不再告警', async () => {
    const deps = guardOn(3_000_000, true);
    const out = await runStepGuards({ wu: makeWu(), metadata: {} }, deps);

    expect(out.result?.action).toBe('need_input');
    expect(deps.notifyBudgetTripped).not.toHaveBeenCalled();
  });

  it('当日已耗 < 预算：放行', async () => {
    const deps = guardOn(1_999_999);
    const out = await runStepGuards({ wu: makeWu(), metadata: {} }, deps);

    expect(out.result).toBeNull();
    expect(deps.notifyBudgetTripped).not.toHaveBeenCalled();
  });

  it('预算 <=0：关闭熔断，已耗再高也放行', async () => {
    const deps = makeDeps({
      tokenBudgetGuardEnabled: vi.fn().mockReturnValue(true),
      resolveDailyTokenBudget: vi.fn().mockReturnValue(0),
      getDailyTokenUsage: vi.fn().mockResolvedValue({ dateKey: '2026-09-15', usedTokens: 999_999_999, notified: false }),
    });
    const out = await runStepGuards({ wu: makeWu(), metadata: {} }, deps);

    expect(out.result).toBeNull();
    expect(deps.getDailyTokenUsage).not.toHaveBeenCalled(); // 预算 <=0 不查用量
  });

  it('守卫开关关闭：不查用量直接放行', async () => {
    const deps = makeDeps({ tokenBudgetGuardEnabled: vi.fn().mockReturnValue(false) });
    const out = await runStepGuards({ wu: makeWu(), metadata: {} }, deps);

    expect(out.result).toBeNull();
    expect(deps.getDailyTokenUsage).not.toHaveBeenCalled();
  });
});

describe('step-guards: #162 WU 级 tokenBudget 熔断', () => {
  it('_cumulativeTokens ≥ tokenBudget：need_input + waitingReason=wu-token-budget + 人话三选文案', async () => {
    const deps = makeDeps();
    const out = await runStepGuards({
      wu: makeWu(),
      metadata: { tokenBudget: 1000, _cumulativeTokens: 1500 },
    }, deps);

    expect(out.result?.action).toBe('need_input');
    expect(out.result?.metadataUpdates?.waitingReason).toBe('wu-token-budget');
    expect(out.result?.summary).toContain('追加预算');
    expect(out.result?.summary).toContain('收尾');
    expect(out.result?.summary).toContain('放弃');
  });

  it('_cumulativeTokens < tokenBudget：放行', async () => {
    const out = await runStepGuards({
      wu: makeWu(),
      metadata: { tokenBudget: 1000, _cumulativeTokens: 999 },
    }, makeDeps());
    expect(out.result).toBeNull();
  });

  it('无 tokenBudget / <=0 / 非法值：不受限放行', async () => {
    for (const metadata of [
      { _cumulativeTokens: 999_999 },
      { tokenBudget: 0, _cumulativeTokens: 999_999 },
      { tokenBudget: Number.NaN, _cumulativeTokens: 999_999 },
      { tokenBudget: -5, _cumulativeTokens: 999_999 },
    ]) {
      const out = await runStepGuards({ wu: makeWu(), metadata }, makeDeps());
      expect(out.result).toBeNull();
    }
  });
});

describe('step-guards: #471 plan 步数额度熔断', () => {
  it('plan + stepCount ≥ 默认额度（PLAN_STEP_LIMIT）：need_input + waitingReason=plan-step-limit', async () => {
    const out = await runStepGuards({
      wu: makeWu({ type: 'plan' }),
      metadata: { stepCount: PLAN_STEP_LIMIT },
    }, makeDeps());

    expect(out.result?.action).toBe('need_input');
    expect(out.result?.metadataUpdates?.waitingReason).toBe('plan-step-limit');
    expect(out.result?.summary).toContain('步数额度');
  });

  it('plan + 自定义 planStepAllowance：未达额度放行；续期后额度生效', async () => {
    const below = await runStepGuards({
      wu: makeWu({ type: 'plan' }),
      metadata: { stepCount: 61, planStepAllowance: 120 },
    }, makeDeps());
    expect(below.result).toBeNull();

    const at = await runStepGuards({
      wu: makeWu({ type: 'plan' }),
      metadata: { stepCount: 120, planStepAllowance: 120 },
    }, makeDeps());
    expect(at.result?.action).toBe('need_input');
  });

  it('非 plan 类型：stepCount 再高也不进本守卫', async () => {
    const out = await runStepGuards({
      wu: makeWu({ type: 'task' }),
      metadata: { stepCount: PLAN_STEP_LIMIT + 100 },
    }, makeDeps());
    expect(out.result).toBeNull();
  });
});

describe('step-guards: 守卫链顺序与短路', () => {
  it('B2 命中时后续守卫不跑（日预算不查询、WU 预算不判）', async () => {
    const deps = makeDeps({
      testWuGuardEnabled: vi.fn().mockReturnValue(true),
      isTestLikeWorkUnit: vi.fn().mockReturnValue(true),
      tokenBudgetGuardEnabled: vi.fn().mockReturnValue(true),
    });
    const out = await runStepGuards({
      wu: makeWu(),
      metadata: { tokenBudget: 1000, _cumulativeTokens: 1500 },
    }, deps);

    expect(out.result?.action).toBe('skipped');
    expect(deps.getDailyTokenUsage).not.toHaveBeenCalled();
  });

  it('日预算熔断时 WU 预算/plan 守卫不跑（日预算优先）', async () => {
    const deps = makeDeps({
      tokenBudgetGuardEnabled: vi.fn().mockReturnValue(true),
      resolveDailyTokenBudget: vi.fn().mockReturnValue(100),
      getDailyTokenUsage: vi.fn().mockResolvedValue({ dateKey: '2026-09-15', usedTokens: 500, notified: true }),
    });
    const out = await runStepGuards({
      wu: makeWu({ type: 'plan' }),
      metadata: { tokenBudget: 1000, _cumulativeTokens: 1500, stepCount: PLAN_STEP_LIMIT },
    }, deps);

    expect(out.result?.action).toBe('need_input');
    expect(out.result?.summary).toContain('预算已熔断'); // 日预算文案，非 WU 预算三选
    expect(out.result?.metadataUpdates?.waitingReason).toBeUndefined();
  });

  it('WU 预算熔断时 plan 守卫不跑（WU 预算优先）', async () => {
    const out = await runStepGuards({
      wu: makeWu({ type: 'plan' }),
      metadata: { tokenBudget: 1000, _cumulativeTokens: 1500, stepCount: PLAN_STEP_LIMIT },
    }, makeDeps());

    expect(out.result?.metadataUpdates?.waitingReason).toBe('wu-token-budget');
  });

  it('全部放行：result=null', async () => {
    const out = await runStepGuards({ wu: makeWu(), metadata: {} }, makeDeps());
    expect(out.result).toBeNull();
  });
});
