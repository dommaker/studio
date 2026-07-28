// §9.6 P0: Executor 接口 — LocalExecutor 原样委托 agentRunner.executeLightweight；
// AgentLoop.agentStep 经 Executor 接口执行（选择逻辑 P1 才接入，现恒为 LocalExecutor）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop } from '../agent-loop';
import { LocalExecutor } from '../executor.js';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';

function makeResult(overrides?: Partial<ExecutionResult>): ExecutionResult {
  return {
    success: true,
    outputText: 'ACTION: COMPLETE:done',
    logFile: '/tmp/log',
    worktree: '/tmp/wt',
    outputFiles: [],
    sessionCount: 1,
    ...overrides,
  } as ExecutionResult;
}

describe('LocalExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to agentRunner.executeLightweight and returns the result verbatim', async () => {
    const result = makeResult();
    mockExecuteLightweight.mockResolvedValue(result);
    const task = {
      id: 't-1', executionId: 'e-1', provider: 'claude', prompt: 'do it',
      parameters: {}, timeoutMs: 1000,
    } as unknown as AgentTask;

    const out = await new LocalExecutor().execute(task);

    expect(mockExecuteLightweight).toHaveBeenCalledWith(task);
    expect(out).toBe(result); // 同一引用 — 结果形状原样透传，零行为变化
  });
});

describe('AgentLoop agentStep via Executor interface', () => {
  let testDir: string;
  let fileStore: FileStore;

  const mockRole = {
    id: 'role-exec',
    name: 'exec-agent',
    description: 'task executor (executor test)',
    channels: '[]',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-executor-'));
    fileStore = new FileStore(testDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('agentStep calls this.executor.execute with the built AgentTask', async () => {
    const spy = vi.spyOn(LocalExecutor.prototype, 'execute');
    mockExecuteLightweight.mockResolvedValue(makeResult());

    const agentLoop = new AgentLoop(mockRole, fileStore);
    // FileStore 里建 state，让 agentStep 内 updateState 不抛 "not found"
    await fileStore.createState('instance-exec', {
      id: 'instance-exec', roleId: mockRole.id, sessionId: null,
      status: 'active', currentWorkUnitId: null,
      startedAt: new Date().toISOString(), terminatedAt: null,
      lastHeartbeat: null, metadata: null, pid: process.pid,
    });
    // fix/guard-and-resume: WU metadata.sessionId 须与 instance.sessionId 相等才进入
    // 续用路径（避开 non-resume → newSessionId → updateState 持久化），否则 metadata=null
    // 导致每次新建、覆盖原有 exec 逻辑。
    (agentLoop as unknown as { instance: unknown }).instance = {
      id: 'instance-exec',
      roleId: mockRole.id,
      sessionId: 'sess-existing',
      status: 'active',
      currentWorkUnitId: 'wu-exec-1',
      startedAt: new Date().toISOString(),
      terminatedAt: null,
      lastHeartbeat: null,
      metadata: null,
    };

    const target = {
      workUnit: {
        id: 'wu-exec-1', type: 'task', scope: 'test', channelId: 'ch-1',
        status: 'active', assigneeId: 'instance-exec', parentId: null,
        failureType: null, retryCount: 0, timeoutAt: null,
        projectPath: null, metadata: JSON.stringify({ sessionId: 'sess-existing' }), claimedAt: null,
        completedAt: null, createdAt: new Date(), updatedAt: new Date(),
      },
    };

    const step = await (agentLoop as unknown as {
      agentStep(t: unknown): Promise<{ action: string }>;
    }).agentStep(target);

    // 经 Executor 接口调用一次，task 为 agent-loop 构建的 AgentTask 形状
    expect(spy).toHaveBeenCalledTimes(1);
    const task = spy.mock.calls[0][0] as unknown as AgentTask;
    expect(task).toMatchObject({ id: 'wu-exec-1', provider: 'claude' });
    // LocalExecutor 把同一 task 原样传给 agentRunner.executeLightweight
    expect(mockExecuteLightweight).toHaveBeenCalledWith(task);
    // 结果形状与旧路径一致（ExecutionResult.outputText → ACTION 解析）
    expect(step.action).toBe('complete');
  });
});
