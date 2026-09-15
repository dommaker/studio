// 步执行重试策略单测（step-retry-policy，#543）：#94 续用丢失降级与 #96 上下文溢出
// 两段孪生骨架收敛为一份后的显式断言点 —— 纯 ctx 对象 + 注入伪依赖（fake executor），
// 无 vi.mock 模块工厂、不整类构造 AgentLoop（对称 step-guards/completion-gates 的可测试性契约）。
// 覆盖：触发判定（matchStepRetry）、会话配额占额（sessionCount 计入/不计入）、
// 会话簿记回写（sessionId/lastSessionResumed/sessionSummary）、重试 task 改写形态
// （claude 传新号 / kimi 不传、sessionResume 摘除）、prompt 重算参数、成败分叉的
// terminal 形状（failed vs need_input）与副作用调用（recordTokenEvent/recordFailureOutcome/emitFailedStep）。
import { describe, it, expect, vi } from 'vitest';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import {
  matchStepRetry,
  runStepRetry,
  resetUnestablishedSessionBookkeeping,
  MAX_SESSIONS_PER_WU,
  type StepRetryCtx,
  type StepRetryDeps,
} from '../step-retry-policy';
import type { WorkUnitData, WorkUnitMetadata } from '../../../workunit/workunit.service.js';

const RESUME_LOST_DETAIL = 'No conversation found with session ID sess-lost';
const OVERFLOW_DETAIL = 'Prompt is too long';
const NEW_SESSION_ID = '11111111-2222-3333-4444-555555555555';

function makeWu(overrides: Partial<WorkUnitData> = {}): WorkUnitData {
  return {
    id: 'wu-1', parentId: null, type: 'task', scope: '实现登录功能', assigneeId: 'instance-1',
    status: 'active', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, workspaceId: null, metadata: null,
    createdAt: new Date(), updatedAt: new Date(), claimedAt: null, completedAt: null,
    ...overrides,
  };
}

function makeTask(provider: 'claude' | 'kimi' = 'claude'): AgentTask {
  return {
    id: 'wu-1',
    executionId: 'wu-1-1',
    provider,
    prompt: 'ORIGINAL-PROMPT',
    parameters: { sessionId: 'sess-lost', sessionResume: true, maxTurns: 50 },
    timeoutMs: 1000,
  };
}

function failureResult(error: string): ExecutionResult {
  return {
    success: false, error, worktree: '/tmp/wt', outputFiles: [], logFile: '/tmp/log', sessionCount: 1,
  };
}

const SUCCESS_RESULT: ExecutionResult = {
  success: true, outputText: 'ACTION: PROGRESS:继续',
  worktree: '/tmp/wt', outputFiles: [], logFile: '/tmp/log', sessionCount: 1,
};

function makeCtx(overrides: Partial<StepRetryCtx> = {}): StepRetryCtx {
  return {
    wu: makeWu(),
    metadata: {},
    provider: 'claude',
    task: makeTask(),
    firstResult: failureResult(RESUME_LOST_DETAIL),
    detail: RESUME_LOST_DETAIL,
    sessionsUsed: 1,
    resumeSessionId: 'sess-lost',
    metadataUpdates: {},
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StepRetryDeps> = {}) {
  return {
    execute: vi.fn().mockResolvedValue(SUCCESS_RESULT),
    recomposePrompt: vi.fn().mockResolvedValue('RECOMPOSED-PROMPT'),
    recordTokenEvent: vi.fn(),
    recordFailureOutcome: vi.fn(),
    emitFailedStep: vi.fn(),
    newSessionId: vi.fn().mockReturnValue(NEW_SESSION_ID),
    ...overrides,
  };
}

describe('matchStepRetry: 重试触发判定（顺序即优先级）', () => {
  it('续用步报「会话不存在」→ session-resume-lost', () => {
    expect(matchStepRetry({ resumeSessionId: 'sess-lost', detail: RESUME_LOST_DETAIL })).toBe('session-resume-lost');
  });

  it('非续用步报「会话不存在」→ null（不触发降级，也不误判溢出）', () => {
    expect(matchStepRetry({ resumeSessionId: null, detail: RESUME_LOST_DETAIL })).toBeNull();
  });

  it('新建步报溢出错误 → context-overflow', () => {
    expect(matchStepRetry({ resumeSessionId: null, detail: OVERFLOW_DETAIL })).toBe('context-overflow');
  });

  it('续用步报溢出错误（非会话丢失类）→ context-overflow', () => {
    expect(matchStepRetry({ resumeSessionId: 'sess-1', detail: OVERFLOW_DETAIL })).toBe('context-overflow');
  });

  it('普通执行错误 → null', () => {
    expect(matchStepRetry({ resumeSessionId: 'sess-1', detail: 'CLI boom' })).toBeNull();
    expect(matchStepRetry({ resumeSessionId: null, detail: 'CLI boom' })).toBeNull();
  });
});

describe('runStepRetry: session-resume-lost（#94 续用丢失降级）', () => {
  it('配额未满 → 换新号重试成功：task 改写新建形态、sessionCount+1、簿记落新号、prompt 按新建重算', async () => {
    const ctx = makeCtx();
    const deps = makeDeps();

    const out = await runStepRetry(ctx, deps);

    expect(deps.execute).toHaveBeenCalledTimes(1);
    // task 原地改写：claude 传新 UUID、摘除 sessionResume
    expect(ctx.task.parameters?.sessionId).toBe(NEW_SESSION_ID);
    expect(ctx.task.parameters?.sessionResume).toBeUndefined();
    // prompt 重算：isNewSession=true（断链新会话，注入前序进展段由 composer 负责）
    expect(deps.recomposePrompt).toHaveBeenCalledWith({ isNewSession: true });
    expect(ctx.task.prompt).toBe('RECOMPOSED-PROMPT');
    // 占额：降级 = 一次新建会话尝试，sessionCount = sessionsUsed + 1
    expect(ctx.metadataUpdates.sessionCount).toBe(2);
    // 回写：换新号落盘 + 续用标记翻 false
    expect(ctx.metadataUpdates.sessionId).toBe(NEW_SESSION_ID);
    expect(ctx.metadataUpdates.lastSessionResumed).toBe(false);
    // outcome：retried，交还重试结果与新号（agent-loop 走正常成功路径）
    expect(out).toEqual({ kind: 'retried', result: SUCCESS_RESULT, sessionId: NEW_SESSION_ID });
    // 成功路径不重记账（重试结果由 agent-loop 成功路径统一 recordTokenEvent）
    expect(deps.recordTokenEvent).not.toHaveBeenCalled();
    expect(deps.recordFailureOutcome).not.toHaveBeenCalled();
  });

  it('配额已满 → 不起新会话：terminal need_input + failure outcome + failed 步事件，sessionCount 不增', async () => {
    const ctx = makeCtx({ sessionsUsed: MAX_SESSIONS_PER_WU });
    const deps = makeDeps();

    const out = await runStepRetry(ctx, deps);

    expect(deps.execute).not.toHaveBeenCalled();
    expect(out.kind).toBe('terminal');
    if (out.kind !== 'terminal') return;
    expect(out.result.action).toBe('need_input');
    expect(out.result.summary).toContain('续用会话已丢失且会话重建已达上限');
    expect(deps.recordFailureOutcome).toHaveBeenCalledWith(RESUME_LOST_DETAIL);
    expect(deps.emitFailedStep).toHaveBeenCalledWith('need_input', RESUME_LOST_DETAIL, ctx.firstResult);
    expect(ctx.metadataUpdates).not.toHaveProperty('sessionCount');
    expect(ctx.metadataUpdates).not.toHaveProperty('sessionId');
  });

  it('重试仍失败 → terminal failed（errorType/errorDetail/errorAt）：重试记账、簿记重置、sessionCount 计入', async () => {
    const retryFailure = failureResult('CLI boom again');
    const ctx = makeCtx();
    const deps = makeDeps({ execute: vi.fn().mockResolvedValue(retryFailure) });

    const out = await runStepRetry(ctx, deps);

    expect(out.kind).toBe('terminal');
    if (out.kind !== 'terminal') return;
    expect(out.result.action).toBe('failed');
    expect(out.result.summary).toBe('CLI 执行失败: CLI boom again');
    expect(out.result.metadataUpdates?.errorType).toBe('execution_failed');
    expect(out.result.metadataUpdates?.errorDetail).toBe('CLI boom again');
    expect(typeof out.result.metadataUpdates?.errorAt).toBe('string');
    // 失败的重试照样烧 token → 记账；失败 outcome + failed 步事件
    expect(deps.recordTokenEvent).toHaveBeenCalledWith(retryFailure);
    expect(deps.recordFailureOutcome).toHaveBeenCalledWith('CLI boom again');
    expect(deps.emitFailedStep).toHaveBeenCalledWith('failed', 'CLI boom again', retryFailure);
    // 新会话未建立：sessionId/lastSessionResumed 回滚，sessionCount 保留计入（#95）
    expect(ctx.metadataUpdates).not.toHaveProperty('sessionId');
    expect(ctx.metadataUpdates).not.toHaveProperty('lastSessionResumed');
    expect(ctx.metadataUpdates.sessionCount).toBe(2);
  });

  it('非 claude provider（kimi cwd 维度续用）→ 重试不传 sessionId', async () => {
    const ctx = makeCtx({ provider: 'kimi', task: makeTask('kimi') });
    const deps = makeDeps();

    const out = await runStepRetry(ctx, deps);

    expect(ctx.task.parameters?.sessionId).toBeUndefined();
    expect(ctx.task.parameters?.sessionResume).toBeUndefined();
    expect(out.kind).toBe('retried');
  });
});

describe('runStepRetry: context-overflow（#96 上下文溢出）', () => {
  const overflowMetadata: WorkUnitMetadata = {
    progressLog: [{ step: 1, action: 'progress', summary: '完成数据层', at: '2026-08-12T10:00:00Z' }],
  };

  it('重试成功：摘要落盘、prompt = 重算（isNewSession:false）+ 摘要段、sessionCount+1、簿记落新号', async () => {
    const ctx = makeCtx({
      detail: OVERFLOW_DETAIL,
      firstResult: failureResult(OVERFLOW_DETAIL),
      resumeSessionId: null,
      metadata: overflowMetadata,
    });
    const deps = makeDeps();

    const out = await runStepRetry(ctx, deps);

    expect(deps.execute).toHaveBeenCalledTimes(1);
    // 摘要先于配额判定落盘（scope + progressLog）
    expect(ctx.metadataUpdates.sessionSummary).toContain('实现登录功能');
    expect(ctx.metadataUpdates.sessionSummary).toContain('完成数据层');
    // prompt 重算：isNewSession=false（避免与 handoff 前序进展段重复），摘要段追加在后
    expect(deps.recomposePrompt).toHaveBeenCalledWith({ isNewSession: false });
    expect(ctx.task.prompt).toBe(
      `RECOMPOSED-PROMPT\n\n## 会话摘要（上下文溢出）\n\n${ctx.metadataUpdates.sessionSummary}`,
    );
    expect(ctx.metadataUpdates.sessionCount).toBe(2);
    expect(ctx.metadataUpdates.sessionId).toBe(NEW_SESSION_ID);
    expect(ctx.metadataUpdates.lastSessionResumed).toBe(false);
    expect(out).toEqual({ kind: 'retried', result: SUCCESS_RESULT, sessionId: NEW_SESSION_ID });
  });

  it('配额已满 → 摘要仍落盘 + terminal need_input，不再起新会话', async () => {
    const ctx = makeCtx({
      detail: OVERFLOW_DETAIL,
      firstResult: failureResult(OVERFLOW_DETAIL),
      resumeSessionId: null,
      metadata: overflowMetadata,
      sessionsUsed: MAX_SESSIONS_PER_WU,
    });
    const deps = makeDeps();

    const out = await runStepRetry(ctx, deps);

    expect(deps.execute).not.toHaveBeenCalled();
    expect(typeof ctx.metadataUpdates.sessionSummary).toBe('string');
    expect(out.kind).toBe('terminal');
    if (out.kind !== 'terminal') return;
    expect(out.result.action).toBe('need_input');
    expect(out.result.summary).toContain('上下文溢出且会话重建已达上限');
    expect(deps.recordFailureOutcome).toHaveBeenCalledWith(OVERFLOW_DETAIL);
    expect(deps.emitFailedStep).toHaveBeenCalledWith('need_input', OVERFLOW_DETAIL, ctx.firstResult);
    expect(ctx.metadataUpdates).not.toHaveProperty('sessionCount');
  });

  it('重试仍失败 → terminal need_input（非 failed）：摘要保留、簿记重置、sessionCount 计入', async () => {
    const retryFailure = failureResult('Prompt is too long');
    const ctx = makeCtx({
      detail: OVERFLOW_DETAIL,
      firstResult: failureResult(OVERFLOW_DETAIL),
      resumeSessionId: null,
      metadata: overflowMetadata,
    });
    const deps = makeDeps({ execute: vi.fn().mockResolvedValue(retryFailure) });

    const out = await runStepRetry(ctx, deps);

    expect(out.kind).toBe('terminal');
    if (out.kind !== 'terminal') return;
    expect(out.result.action).toBe('need_input');
    expect(out.result.summary).toContain('上下文溢出');
    expect(out.result.summary).toContain('新会话带摘要重试一次仍失败');
    expect(deps.recordTokenEvent).toHaveBeenCalledWith(retryFailure);
    expect(deps.recordFailureOutcome).toHaveBeenCalledWith('Prompt is too long');
    expect(deps.emitFailedStep).toHaveBeenCalledWith('need_input', 'Prompt is too long', retryFailure);
    expect(typeof ctx.metadataUpdates.sessionSummary).toBe('string');
    expect(ctx.metadataUpdates).not.toHaveProperty('sessionId');
    expect(ctx.metadataUpdates).not.toHaveProperty('lastSessionResumed');
    expect(ctx.metadataUpdates.sessionCount).toBe(2);
  });
});

describe('runStepRetry: 不触发重试', () => {
  it('普通执行错误 → no-retry：零副作用、零簿记改写', async () => {
    const ctx = makeCtx({ detail: 'CLI boom', firstResult: failureResult('CLI boom') });
    const deps = makeDeps();

    const out = await runStepRetry(ctx, deps);

    expect(out).toEqual({ kind: 'no-retry' });
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.recomposePrompt).not.toHaveBeenCalled();
    expect(ctx.metadataUpdates).toEqual({});
  });
});

describe('resetUnestablishedSessionBookkeeping', () => {
  it('摘除 sessionId/lastSessionResumed，保留 sessionCount（失败尝试计入配额，#95）', () => {
    const updates: Partial<WorkUnitMetadata> = {
      sessionId: 'sess-x', lastSessionResumed: false, sessionCount: 3,
    };
    resetUnestablishedSessionBookkeeping(updates);
    expect(updates).not.toHaveProperty('sessionId');
    expect(updates).not.toHaveProperty('lastSessionResumed');
    expect(updates.sessionCount).toBe(3);
  });
});
