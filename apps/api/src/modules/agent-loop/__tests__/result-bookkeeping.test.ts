// recordResult 簿记段单测（result-bookkeeping，#655）：纯 input 对象驱动，无 vi.mock 模块工厂、
// 不整类构造 AgentLoop（对称 step-guards / completion-gates 的可测试性契约）。
// 覆盖：stepCount/consecutiveStuck 推导、F5 挂起标记（#467 rulings / #567 directions 优先）、
// B4 blocked 原因各分支、#170 锁内合并 mutator（字段优先级 / progressLog 环形 /
// pendingReplies 三段合成 / guardUpdates 引用闭包——F6-c 后置 mutate 须被包含）。
import { describe, it, expect } from 'vitest';
import {
  prepareRecordBookkeeping,
  type RecordBookkeepingInput,
} from '../result-bookkeeping';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/workunit.service.js';
import type { StepResult } from '../agent-loop.js';

function makeWu(overrides: Partial<WorkUnitData> = {}): WorkUnitData {
  return {
    id: 'wu-1', parentId: null, type: 'task', scope: '实现功能', assigneeId: 'instance-1',
    status: 'active', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, workspaceId: null, metadata: null,
    createdAt: new Date(), updatedAt: new Date(), claimedAt: null, completedAt: null,
    ...overrides,
  };
}

function makeResult(overrides: Partial<StepResult> = {}): StepResult {
  return { action: 'progress', summary: '本步进展', ...overrides };
}

function makeInput(overrides: Partial<RecordBookkeepingInput> = {}): RecordBookkeepingInput {
  return {
    wu: makeWu(),
    metadata: {},
    action: 'progress',
    result: makeResult(),
    guardUpdates: {},
    freshnessUpdates: {},
    notices: { verifyBlocked: false, diffEmptyBlocked: false, contractArtifactBlocked: false },
    ...overrides,
  };
}

describe('result-bookkeeping: stepCount / consecutiveStuck 推导', () => {
  it('progress → consecutiveStuck 归零；stepCount = (metadata.stepCount ?? 0) + 1', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'progress',
      metadata: { stepCount: 4, consecutiveStuck: 2 },
    }));
    expect(out.stepCount).toBe(5);
    expect(out.consecutiveStuck).toBe(0);
  });

  it('metadata.stepCount 缺省 → stepCount = 1', () => {
    const out = prepareRecordBookkeeping(makeInput({ action: 'progress' }));
    expect(out.stepCount).toBe(1);
  });

  it('非 progress action → consecutiveStuck +1（缺省视为 0）', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'failed',
      result: makeResult({ action: 'failed', summary: 'boom' }),
      metadata: { consecutiveStuck: 2 },
    }));
    expect(out.consecutiveStuck).toBe(3);
    const fresh = prepareRecordBookkeeping(makeInput({
      action: 'complete',
      result: makeResult({ action: 'complete' }),
    }));
    expect(fresh.consecutiveStuck).toBe(1);
  });
});

describe('result-bookkeeping: F5 waitingUpdates', () => {
  it('need_input 挂起：四字段落档（waitingForInput/waitingQuestion/waitingSince/waitingReminded）', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'need_input',
      result: makeResult({ action: 'need_input', summary: '请确认方案' }),
    }));
    expect(out.waitingUpdates.waitingForInput).toBe(true);
    expect(out.waitingUpdates.waitingQuestion).toBe('请确认方案');
    expect(typeof out.waitingUpdates.waitingSince).toBe('string');
    expect(out.waitingUpdates.waitingReminded).toBe(false);
    expect(out.waitingUpdates.planRulings).toBeUndefined();
    expect(out.waitingUpdates.waitingReason).toBeUndefined();
  });

  it('need_input 带 rulings → planRulings + waitingReason=plan-ruling（#467）', () => {
    const rulings = [{ question: 'q1', suggestion: 's1', default: 'd1' }];
    const out = prepareRecordBookkeeping(makeInput({
      action: 'need_input',
      result: makeResult({ action: 'need_input', summary: '请裁决', rulings }),
    }));
    expect(out.waitingUpdates.planRulings).toEqual(rulings);
    expect(out.waitingUpdates.waitingReason).toBe('plan-ruling');
  });

  it('need_input 带 directions（与 rulings 并存）→ direction 优先：waitingReason=plan-direction（#567）', () => {
    const rulings = [{ question: 'q1', suggestion: 's1' }];
    const directions = {
      question: '走哪条路',
      options: [
        { name: 'A', summary: 's', tradeoffs: 't', impact: 'i', recommended: true },
        { name: 'B', summary: 's', tradeoffs: 't', impact: 'i', recommended: false },
      ],
    };
    const out = prepareRecordBookkeeping(makeInput({
      action: 'need_input',
      result: makeResult({ action: 'need_input', summary: '请定向', rulings, directions }),
    }));
    expect(out.waitingUpdates.planDirections).toEqual(directions);
    expect(out.waitingUpdates.planRulings).toEqual(rulings);
    expect(out.waitingUpdates.waitingReason).toBe('plan-direction');
  });

  it('非 need_input 且原挂起中 → 清除两字段', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'progress',
      metadata: { waitingForInput: true, waitingReminded: true },
    }));
    expect(out.waitingUpdates).toEqual({ waitingForInput: false, waitingReminded: false });
  });

  it('非 need_input 且未挂起 → 空对象', () => {
    const out = prepareRecordBookkeeping(makeInput({ action: 'progress' }));
    expect(out.waitingUpdates).toEqual({});
  });
});

describe('result-bookkeeping: B4 blockReasonUpdates', () => {
  it('verifyBlocked → verify-failed x<count>', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'progress',
      guardUpdates: { verifyFailCount: 3 },
      notices: { verifyBlocked: true, diffEmptyBlocked: false, contractArtifactBlocked: false },
    }));
    expect(out.blockReasonUpdates.blockReason).toBe('verify-failed x3: 自动验证连续失败');
  });

  it('diffEmptyBlocked → diff-empty x<count>', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'progress',
      guardUpdates: { diffEmptyCount: 2 },
      notices: { verifyBlocked: false, diffEmptyBlocked: true, contractArtifactBlocked: false },
    }));
    expect(out.blockReasonUpdates.blockReason).toBe('diff-empty x2: 报告完成但无提交内容');
  });

  it('contractArtifactBlocked → contract-artifact x<count>', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'progress',
      guardUpdates: { contractArtifactCount: 4 },
      notices: { verifyBlocked: false, diffEmptyBlocked: false, contractArtifactBlocked: true },
    }));
    expect(out.blockReasonUpdates.blockReason).toBe('contract-artifact x4: 契约产物连续缺失');
  });

  it('consecutiveStuck>=3 且 failed 带 summary → stuck 带摘要', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'failed',
      result: makeResult({ action: 'failed', summary: 'CLI 超时' }),
      metadata: { consecutiveStuck: 2 },
    }));
    expect(out.blockReasonUpdates.blockReason).toBe('stuck: 连续 3 步无进展（CLI 超时）');
  });

  it('consecutiveStuck>=3 且 failed 无 summary → stuck 不带摘要', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'failed',
      result: makeResult({ action: 'failed', summary: '' }),
      metadata: { consecutiveStuck: 2 },
    }));
    expect(out.blockReasonUpdates.blockReason).toBe('stuck: 连续 3 步无进展');
  });

  it('need_input → need-input: <summary 截 200>', () => {
    const summary = 'x'.repeat(300);
    const out = prepareRecordBookkeeping(makeInput({
      action: 'need_input',
      result: makeResult({ action: 'need_input', summary }),
    }));
    expect(out.blockReasonUpdates.blockReason).toBe(`need-input: ${'x'.repeat(200)}`);
  });

  it('本步不走 blocked 路径且有陈旧 blockReason → undefined 清除', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'progress',
      metadata: { blockReason: 'stuck: 连续 3 步无进展' },
    }));
    expect('blockReason' in out.blockReasonUpdates).toBe(true);
    expect(out.blockReasonUpdates.blockReason).toBeUndefined();
  });

  it('无任何触发且无陈旧原因 → 空对象', () => {
    const out = prepareRecordBookkeeping(makeInput({ action: 'progress' }));
    expect(out.blockReasonUpdates).toEqual({});
  });
});

describe('result-bookkeeping: #170 锁内合并 mutator', () => {
  it('字段合并优先级：stepUpdates < waitingUpdates < guardUpdates < freshnessUpdates < blockReasonUpdates', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'need_input',
      result: makeResult({
        action: 'need_input',
        summary: '请确认',
        metadataUpdates: { waitingForInput: false, traceId: 'from-step', blockReason: 'from-step' },
      }),
      guardUpdates: { traceId: 'from-guard', blockReason: 'from-guard' },
      freshnessUpdates: { traceId: 'from-fresh', blockReason: 'from-fresh' },
    }));
    const next = out.mutator({}) as WorkUnitMetadata;
    expect(next.traceId).toBe('from-fresh');              // freshnessUpdates > guardUpdates > stepUpdates
    expect(next.waitingForInput).toBe(true);              // waitingUpdates > stepUpdates
    expect(next.blockReason).toBe('need-input: 请确认');   // blockReasonUpdates 最优先
  });

  it('stepCount/consecutiveStuck 锁内重计：以 latest 为准（忽略锁外推导值）', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'failed',
      result: makeResult({ action: 'failed', summary: 'boom' }),
      metadata: { stepCount: 0, consecutiveStuck: 0 },
    }));
    const next = out.mutator({ stepCount: 10, consecutiveStuck: 7 }) as WorkUnitMetadata;
    expect(next.stepCount).toBe(11);
    expect(next.consecutiveStuck).toBe(8);
  });

  it('mutator 按引用闭包 guardUpdates：prepare 之后追加的 mutate（F6-c）在锁内展开时被包含', () => {
    const guardUpdates: Partial<WorkUnitMetadata> = {};
    const out = prepareRecordBookkeeping(makeInput({ action: 'progress', guardUpdates }));
    // F6-c 强制收口段在 prepare 之后、updateMetadata 之前 mutate guardUpdates
    guardUpdates.attestations = { l1: { verdict: 'approved', by: 'dev', at: '2026-09-29T00:00:00Z', kind: 'verify', summary: 'ok' } };
    const next = out.mutator({}) as WorkUnitMetadata;
    expect(next.attestations).toEqual(guardUpdates.attestations);
  });

  it('progressLog 环形：progress 追加（截 200、保留最近 5 条、step=锁内 nextStepCount）', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'progress',
      result: makeResult({ action: 'progress', summary: 's'.repeat(300) }),
    }));
    const prevLog = [1, 2, 3, 4, 5].map(step => ({ step, action: 'progress', summary: `old-${step}`, at: '2026-09-01T00:00:00Z' }));
    const next = out.mutator({ stepCount: 5, progressLog: prevLog }) as WorkUnitMetadata;
    expect(next.progressLog).toHaveLength(5);
    expect(next.progressLog?.[0].step).toBe(2); // 最旧一条被挤出
    const appended = next.progressLog?.[4];
    expect(appended?.step).toBe(6);
    expect(appended?.action).toBe('progress');
    expect(appended?.summary).toBe('s'.repeat(200));
    expect(typeof appended?.at).toBe('string');
  });

  it('progressLog 环形：complete 也追加；failed 不追加', () => {
    const complete = prepareRecordBookkeeping(makeInput({
      action: 'complete',
      result: makeResult({ action: 'complete', summary: 'done' }),
    }));
    const afterComplete = complete.mutator({ stepCount: 0 }) as WorkUnitMetadata;
    expect(afterComplete.progressLog).toHaveLength(1);
    expect(afterComplete.progressLog?.[0].action).toBe('complete');

    const failed = prepareRecordBookkeeping(makeInput({
      action: 'failed',
      result: makeResult({ action: 'failed', summary: 'boom' }),
    }));
    const prevLog = [{ step: 1, action: 'progress', summary: 'old', at: '2026-09-01T00:00:00Z' }];
    const afterFailed = failed.mutator({ progressLog: prevLog }) as WorkUnitMetadata;
    expect(afterFailed.progressLog).toEqual(prevLog);
  });

  it('pendingReplies 三段合成：consumedPending 精确 slice 掉 stepStartReplyCount 条，保留锁内新到回复', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'progress',
      wu: makeWu({ metadata: JSON.stringify({ pendingReplies: ['a', 'b'] }) }),
      result: makeResult({ action: 'progress', metadataUpdates: { pendingReplies: undefined } }),
    }));
    // 锁内最新值：step 期间经 waiting-input 新到一条 'c'
    const next = out.mutator({ pendingReplies: ['a', 'b', 'c'] }) as WorkUnitMetadata;
    expect(next.pendingReplies).toEqual(['c']);
  });

  it('pendingReplies 三段合成：freshnessHeld 尾部追加', () => {
    const out = prepareRecordBookkeeping(makeInput({
      action: 'progress',
      freshnessUpdates: { pendingReplies: ['x', 'y'] },
    }));
    const next = out.mutator({ pendingReplies: ['a'] }) as WorkUnitMetadata;
    expect(next.pendingReplies).toEqual(['a', 'x', 'y']);
  });

  it('pendingReplies 三段合成：合成后为空 → delete（键不存在）', () => {
    // consumed 后清空
    const consumed = prepareRecordBookkeeping(makeInput({
      action: 'progress',
      wu: makeWu({ metadata: JSON.stringify({ pendingReplies: ['a'] }) }),
      result: makeResult({ action: 'progress', metadataUpdates: { pendingReplies: undefined } }),
    }));
    const next = consumed.mutator({ pendingReplies: ['a'] }) as WorkUnitMetadata;
    expect('pendingReplies' in next).toBe(false);

    // 本来就没有
    const empty = prepareRecordBookkeeping(makeInput({ action: 'progress' }));
    const next2 = empty.mutator({}) as WorkUnitMetadata;
    expect('pendingReplies' in next2).toBe(false);
  });
});
