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
import { WorkUnitService } from '../../workunit/workunit-review.js';
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

  it('defaultPath 执行期间持固定目录 capability，返回路径不泄露已关闭 fd', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-executor-capability-'));
    const repo = path.join(root, 'repo');
    const original = path.join(root, 'repo-original');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(repo);
    fs.mkdirSync(outside);
    try {
      mockExecuteLightweight.mockImplementation(async (task: AgentTask) => {
        const capabilityPath = task.parameters!.workspaceRoot as string;
        expect(capabilityPath).toMatch(new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
        fs.renameSync(repo, original);
        fs.symlinkSync(outside, repo);
        fs.writeFileSync(path.join(capabilityPath, 'safe.txt'), 'safe');
        return makeResult({ worktree: capabilityPath, logFile: path.join(capabilityPath, '.agent.log') });
      });
      const task = {
        id: 't-cap', executionId: 'e-cap', provider: 'claude', prompt: 'do it',
        parameters: { workspaceRoot: repo }, timeoutMs: 1000,
      } as unknown as AgentTask;
      const out = await new LocalExecutor().execute(task);

      expect(fs.existsSync(path.join(outside, 'safe.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(original, 'safe.txt'), 'utf8')).toBe('safe');
      expect(out.worktree).toBe(repo);
      expect(out.logFile).toBe(path.join(repo, '.agent.log'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AgentLoop agentStep via Executor interface', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;

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
    wuService = new WorkUnitService(fileStore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('agentStep calls this.executor.execute with the built AgentTask', async () => {
    const spy = vi.spyOn(LocalExecutor.prototype, 'execute');
    mockExecuteLightweight.mockResolvedValue(makeResult());

    // #94: 续用判定只信档案 metadata.sessionId（不再读 instance 槽位）；本用例 WU 无
    // workspaceId/workspaceRoot → cwd=null → claude 无法校验会话文件按续用处理，
    // 避开新建分支的会话签发，保持既有 exec 逻辑断言聚焦 Executor 接口形状。
    const instance = {
      id: 'instance-exec', roleId: mockRole.id, sessionId: 'sess-existing',
      status: 'active', currentWorkUnitId: 'wu-exec-1',
      startedAt: new Date().toISOString(), terminatedAt: null,
      lastHeartbeat: null, metadata: null, pid: process.pid,
    };
    await fileStore.createState(instance.id, instance);
    const agentLoop = new AgentLoop(mockRole, fileStore, { instance });

    // #705 起 agentStep 要求持久化快照（ExecutionJournal.beginStep 读 store 内记录）
    const created = await wuService.create({
      scope: 'test', type: 'task', status: 'unassigned', assigneeId: 'instance-exec', channelId: 'ch-1',
      metadata: { sessionId: 'sess-existing' },
    });
    const wu = await wuService.claim(created.id, 'instance-exec');
    const target = { workUnit: wu };

    const step = await agentLoop.agentStep(target);

    // 经 Executor 接口调用一次，task 为 agent-loop 构建的 AgentTask 形状
    expect(spy).toHaveBeenCalledTimes(1);
    const task = spy.mock.calls[0][0] as unknown as AgentTask;
    expect(task).toMatchObject({ id: wu.id, provider: 'claude' });
    // LocalExecutor 把同一 task 原样传给 agentRunner.executeLightweight
    expect(mockExecuteLightweight).toHaveBeenCalledWith(task);
    // 结果形状与旧路径一致（ExecutionResult.outputText → ACTION 解析）
    expect(step.action).toBe('complete');
  });
});
