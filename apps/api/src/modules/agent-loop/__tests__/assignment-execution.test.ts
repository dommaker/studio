import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, readStudioEvents } from '@dommaker/studio-shared';
import { readTranscript } from '../../transcripts/index.js';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import { WorkUnitService } from '../../workunit/workunit-review.js';
import { resumeWaitingWorkUnit } from '../../workunit/waiting-input.js';
import type { Executor } from '../executor.js';

vi.mock('../../knowledge/index', () => {
  const knowledgeService = {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
    extractFromConversation: vi.fn().mockResolvedValue(undefined),
  };
  return {
    knowledgeService,
    knowledgePorts: { consume: knowledgeService, produce: knowledgeService, track: knowledgeService },
  };
});

import { AgentLoop } from '../agent-loop.js';

const role = {
  id: 'role-assignment', name: 'assignment-agent', description: 'assignment test', channels: '[]',
  status: 'active', provider: 'claude', createdAt: new Date(), updatedAt: new Date(),
};

let tmpDir: string;
let store: FileStore;
let service: WorkUnitService;
let loop: AgentLoop;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assignment-execution-'));
  store = new FileStore(tmpDir);
  service = new WorkUnitService(store);
});

afterEach(() => {
  loop?.stopLease();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createLoop(execute: Executor['execute']): AgentLoop {
  return new AgentLoop(role, store, {
    executor: { execute },
    instance: {
      id: 'instance-1', roleId: role.id, sessionId: null, status: 'active', currentWorkUnitId: null,
      startedAt: new Date().toISOString(), terminatedAt: null, metadata: null, lastHeartbeat: null,
    },
  });
}

async function createClaimed() {
  const created = await service.create({ scope: '执行轮次', type: 'task', status: 'unassigned' });
  return service.claim(created.id, 'instance-1');
}

describe('AgentLoop Assignment 执行轮次', () => {
  it('开始执行把 queued 转为 running，结果进展和 StepRecord 聚合到同一轮', async () => {
    loop = createLoop(vi.fn().mockResolvedValue({
      success: true,
      outputText: 'STEP_RECORD: {"acProgress":[{"ac":"AC1","status":"completed"}],"decisions":["保留事件流"],"nextStep":"继续验证"}\nACTION: PROGRESS:已完成第一步',
      rawOutput: [
        '{"type":"assistant","content":[{"type":"tool_use","id":"cmd-1","name":"Bash","input":{"command":"pnpm typecheck"}},{"type":"tool_use","id":"edit-1","name":"Edit","input":{"file_path":"/repo/a.ts"}}]}',
        '{"type":"user","content":[{"type":"tool_result","tool_use_id":"cmd-1","is_error":false},{"type":"tool_result","tool_use_id":"edit-1","is_error":false}]}',
      ].join('\n'),
      totalDurationMs: 1,
    }));
    const claimed = await createClaimed();
    loop.ensureLease(claimed);

    const result = await loop.agentStep({ workUnit: claimed });
    const running = await service.getById(claimed.id);
    expect(result.assignmentId).toBe(claimed.execution?.current?.id);
    expect(running?.execution?.current?.status).toBe('running');

    await loop.recordResult({ workUnit: claimed }, result);
    const recorded = await service.getById(claimed.id);
    expect(recorded?.execution?.current).toMatchObject({ status: 'running', progressCount: 1 });
    expect(recorded?.execution?.totals.progressCount).toBe(1);
    const snapshot = (await store.getIndex({ id: claimed.id }))[0];
    expect(snapshot.stepRecords).toHaveLength(1);
    expect(snapshot.stepRecords![0]).toMatchObject({
      assignmentId: result.assignmentId,
      acProgress: [{ ac: 'AC1', status: 'completed' }],
      modifiedFiles: ['/repo/a.ts'],
      commands: [{ command: 'pnpm typecheck', status: 'passed' }],
      decisions: ['保留事件流'],
      nextStep: '继续验证',
    });
    expect(snapshot.stepRecords![0].transcriptRefs[0]).toContain(`#step=1`);
  });

  it('NEED_INPUT 回复 supersede 旧 waiting 并创建链接的 queued 轮次', async () => {
    loop = createLoop(vi.fn());
    const claimed = await createClaimed();
    const waitingId = claimed.execution?.current?.id;

    await loop.recordResult({ workUnit: claimed }, { action: 'need_input', summary: '选择哪个方案？' });
    expect((await service.getById(claimed.id))?.execution?.current?.status).toBe('waiting');

    await expect(resumeWaitingWorkUnit(claimed.id, '使用方案 A', store)).resolves.toBe(true);
    const resumed = await service.getById(claimed.id);
    expect(resumed?.status).toBe('active');
    expect(resumed?.execution?.current).toMatchObject({
      attempt: 2,
      status: 'queued',
      previousAssignmentId: waitingId,
      reason: 'need-input-reply',
    });
    expect(resumed?.execution?.assignments.map(a => a.status)).toEqual(['superseded', 'queued']);
  });

  it('token 预算的继续回复同样 supersede waiting 并链接新轮次', async () => {
    loop = createLoop(vi.fn());
    const claimed = await createClaimed();
    const waitingId = claimed.execution?.current?.id;
    await loop.recordResult({ workUnit: claimed }, { action: 'need_input', summary: '预算到线' });
    await service.updateMetadata(claimed.id, {
      waitingReason: 'wu-token-budget', tokenBudget: 10, _cumulativeTokens: 10,
    });

    await expect(resumeWaitingWorkUnit(claimed.id, '继续', store)).resolves.toBe(true);
    const resumed = await service.getById(claimed.id);
    expect(resumed?.execution?.current).toMatchObject({
      attempt: 2,
      status: 'queued',
      previousAssignmentId: waitingId,
      reason: 'need-input-reply',
    });
    expect(resumed?.execution?.assignments[0].status).toBe('superseded');
  });

  it('session 替换创建新轮次，旧 Assignment 的迟到结果不能写回 WU', async () => {
    const executionIds: string[] = [];
    const execute = vi.fn()
      .mockImplementationOnce((task: AgentTask) => {
        executionIds.push(task.executionId);
        return Promise.resolve({
          success: false,
          error: 'No conversation found with session ID sess-old',
          usage: { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        });
      })
      .mockImplementationOnce((task: AgentTask) => {
        executionIds.push(task.executionId);
        return Promise.resolve({
          success: true,
          outputText: 'ACTION: PROGRESS:新会话继续',
          rawOutput: '',
          usage: { inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        });
      });
    loop = createLoop(execute);
    const claimed = await createClaimed();
    const oldAssignmentId = claimed.execution?.current?.id;
    await service.updateMetadata(claimed.id, { sessionId: 'sess-old', sessionCount: 1 });
    const resumable = (await service.getById(claimed.id))!;
    loop.ensureLease(resumable);

    const result = await loop.agentStep({ workUnit: resumable });
    const replaced = await service.getById(claimed.id);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(new Set(executionIds).size).toBe(2);
    expect(result.assignmentId).not.toBe(oldAssignmentId);
    expect(replaced?.execution?.current).toMatchObject({
      attempt: 2,
      status: 'running',
      previousAssignmentId: oldAssignmentId,
      reason: 'session-replacement',
    });
    expect(replaced?.execution?.assignments[0].status).toBe('superseded');
    expect(replaced?.execution?.assignments.map(a => a.tokenCount)).toEqual([2, 3]);
    expect(replaced?.execution?.totals.tokenCount).toBe(5);

    await loop.recordResult({ workUnit: resumable }, {
      action: 'complete', summary: '旧会话迟到完成', assignmentId: oldAssignmentId,
      metadataUpdates: { staleWrite: true },
    });
    const afterLateResult = await service.getById(claimed.id);
    expect(afterLateResult?.status).toBe('active');
    expect(afterLateResult?.metadata).not.toContain('staleWrite');
    expect(afterLateResult?.metadata).not.toContain('stepCount');
    expect(afterLateResult?.execution?.current?.id).toBe(result.assignmentId);
  });

  it('同真实 CLI session 的 NEED_INPUT linked Assignment 继承已呈现游标', async () => {
    vi.stubEnv('STUDIO_INCREMENTAL_CONTEXT', 'true');
    const execute = vi.fn()
      .mockResolvedValueOnce({ success: true, outputText: 'ACTION: NEED_INPUT:选择哪个方案？', rawOutput: '' })
      .mockResolvedValueOnce({ success: true, outputText: 'ACTION: PROGRESS:按方案 A 继续', rawOutput: '' });
    loop = createLoop(execute);
    const claimed = await createClaimed();
    loop.ensureLease(claimed);

    const first = await loop.agentStep({ workUnit: claimed });
    expect(first.context.mode).toBe('full');
    await loop.recordResult({ workUnit: claimed }, first);
    const waiting = (await store.getIndex({ id: claimed.id }))[0];
    const waitingAssignment = waiting.assignments?.find(a => a.id === waiting.currentAssignmentId);
    expect(waitingAssignment?.cliSessionId).toBe(first.metadataUpdates?.sessionId);
    expect(waitingAssignment?.presentedContext).toEqual(first.contextCursor);

    await resumeWaitingWorkUnit(claimed.id, '使用方案 A', store);
    const resumed = (await service.getById(claimed.id))!;
    loop.ensureLease(resumed);
    const second = await loop.agentStep({ workUnit: resumed });

    expect(second.context.mode).toBe('delta');
    const secondTask = execute.mock.calls[1][0] as AgentTask;
    expect(secondTask.parameters?.knowledgeContext ?? '').not.toContain('assignment test');
    expect(secondTask.prompt).toContain('使用方案 A');
    await loop.recordResult({ workUnit: resumed }, second);
    const current = (await store.getIndex({ id: claimed.id }))[0];
    expect(current.assignments?.find(a => a.id === current.currentAssignmentId)?.presentedContext)
      .toEqual(second.contextCursor);
    vi.unstubAllEnvs();
  });

  it('上下文溢出替换真实 CLI session 后重置游标并发送完整快照', async () => {
    vi.stubEnv('STUDIO_INCREMENTAL_CONTEXT', 'true');
    const execute = vi.fn()
      .mockResolvedValueOnce({ success: true, outputText: 'ACTION: PROGRESS:首步完成', rawOutput: '' })
      .mockResolvedValueOnce({ success: false, error: 'Prompt is too long' })
      .mockResolvedValueOnce({ success: true, outputText: 'ACTION: PROGRESS:新会话恢复', rawOutput: '' });
    loop = createLoop(execute);
    const claimed = await createClaimed();
    loop.ensureLease(claimed);
    const first = await loop.agentStep({ workUnit: claimed });
    await loop.recordResult({ workUnit: claimed }, first);

    const resumable = (await service.getById(claimed.id))!;
    loop.ensureLease(resumable);
    const recovered = await loop.agentStep({ workUnit: resumable });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(recovered.context.mode).toBe('full');
    const retryTask = execute.mock.calls[2][0] as AgentTask;
    expect(retryTask.parameters?.knowledgeContext).toContain('assignment test');
    expect(retryTask.parameters?.sessionResume).toBeUndefined();
    expect(recovered.assignmentId).not.toBe(first.assignmentId);
    await loop.recordResult({ workUnit: resumable }, recovered);
    const snapshot = (await store.getIndex({ id: claimed.id }))[0];
    const current = snapshot.assignments?.find(a => a.id === snapshot.currentAssignmentId);
    expect(current?.reason).toBe('session-replacement');
    expect(current?.presentedContext).toEqual(recovered.contextCursor);
  });

  it('普通失败后的下一次执行创建链接的 retry Assignment', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'temporary failure' })
      .mockResolvedValueOnce({ success: true, outputText: 'ACTION: PROGRESS:重试成功', rawOutput: '' });
    loop = createLoop(execute);
    const claimed = await createClaimed();
    const first = await loop.agentStep({ workUnit: claimed });
    await loop.recordResult({ workUnit: claimed }, first);
    const failed = await service.getById(claimed.id);
    expect(failed?.execution?.current).toMatchObject({ id: first.assignmentId, status: 'failed' });

    const retry = await loop.agentStep({ workUnit: failed! });
    const running = await service.getById(claimed.id);
    expect(running?.execution?.current).toMatchObject({
      id: retry.assignmentId,
      attempt: 2,
      status: 'running',
      reason: 'retry',
      previousAssignmentId: first.assignmentId,
    });
    expect(running?.execution?.assignments.map(a => a.status)).toEqual(['failed', 'running']);
  });

  it('COMPLETE 只结束当前 Assignment 为 succeeded，WU 进入既有评审态', async () => {
    loop = createLoop(vi.fn());
    const claimed = await createClaimed();

    await loop.recordResult({ workUnit: claimed }, {
      action: 'complete', summary: '实现完成', assignmentId: claimed.execution?.current?.id,
    });

    const completed = await service.getById(claimed.id);
    expect(completed?.status).toBe('in_review');
    expect(completed?.completedAt).toBeNull();
    expect(completed?.execution?.current?.status).toBe('succeeded');
  });

  it('步骤落盘后再返回，recordResult 在完成事件前提交 transcript 终止标记', async () => {
    loop = createLoop(vi.fn().mockResolvedValue({
      success: true,
      outputText: 'ACTION: COMPLETE:归档完成',
      rawOutput: '{"type":"result","result":"归档完成"}',
      totalDurationMs: 1,
    }));
    const claimed = await createClaimed();
    loop.ensureLease(claimed);

    const result = await loop.agentStep({ workUnit: claimed });
    expect(result.transcriptRecorded).toBe(true);
    expect(await readTranscript(claimed.id)).toEqual([]);

    await loop.recordResult({ workUnit: claimed }, result);
    const entries = await readTranscript(claimed.id);
    expect(entries.filter(entry => entry.rawOutput).map(entry => entry.rawOutput))
      .toEqual(['{"type":"result","result":"归档完成"}']);
    expect(entries.at(-1)).toMatchObject({
      assignmentId: result.assignmentId,
      kind: 'terminal',
      status: 'succeeded',
    });
  });

  it('已取消 Assignment 迟到完成不写 token、执行事件或 transcript', async () => {
    let finishExecution: ((result: ExecutionResult) => void) | null = null;
    loop = createLoop(vi.fn(() => new Promise<ExecutionResult>(resolve => { finishExecution = resolve; })));
    const claimed = await createClaimed();
    loop.ensureLease(claimed);
    const inFlight = loop.agentStep({ workUnit: claimed });
    await vi.waitFor(() => expect(loop.currentExecutionId).toBeTruthy());

    await service.close(claimed.id, { closedBy: 'human-command', reason: '取消执行' });
    finishExecution?.({
      success: true,
      outputText: 'ACTION: PROGRESS:迟到结果',
      rawOutput: '{"type":"assistant","message":{"content":[{"type":"text","text":"late"}]}}',
      usage: { inputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    await inFlight;
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(await readTranscript(claimed.id)).toEqual([]);
    const events = await readStudioEvents();
    const lateWrites = events.filter(event => {
      if (event.type !== 'workunit:tokens' && event.type !== 'workunit:execution_step') return false;
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      return payload?.workUnitId === claimed.id;
    });
    expect(lateWrites).toEqual([]);
  });
});
