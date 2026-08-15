/**
 * #171 服务级测试（#54 决议 A1 三层超时 + #67 尾巴删除）：
 *   1. agentStep 构建的 AgentTask：timeoutMs=1800s 墙钟兜底（旧 120s 连健康 p90=128s 都不到）、
 *      silenceWarnMs=300s / silenceKillMs=600s 静默看门狗、maxTurns=50 与 token 记账不变
 *   2. 静默 warn 回调：logger.warn + workunit:step_silence 事件落事件流（批次 D 告警管线读事件流）
 *   3. extractInputTokens / lastInputTokens 五处残留全删（parser、调用点、re-export、类型字段、清理清单）
 *
 * 机制数值作为行为断言（spec Testing Decisions）；真人格杀/孤儿验证在
 * studio-shared process-io-silence.test.ts（真实进程组）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileStore } from '@dommaker/studio-shared';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn().mockReturnValue('Claude Code CLI version 1.0.0'),
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { executeLightweight: mockExecuteLightweight },
}));

vi.mock('../../workunit/workunit.service', () => ({
  WorkUnitService: vi.fn().mockImplementation(function () {
    return {
      claim: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'active' }),
      unclaim: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'unassigned' }),
      transitionStatus: vi.fn().mockResolvedValue({ id: 'wu-1', status: 'in_review' }),
    };
  }),
  snapshotToData: (s: unknown) => s,
}));

vi.mock('../../triggers/trigger-registry', () => ({
  getTriggerScheduler: () => ({
    registerTrigger: vi.fn(),
    unregisterTrigger: vi.fn(),
    registerExecuteHandler: vi.fn(),
    getStates: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import * as agentLoopModule from '../loop/agent-loop';
import { AgentLoop } from '../loop/agent-loop';
import type { AgentTask } from '@dommaker/studio-agent';

describe('#171 三层超时（#54 决议）', () => {
  let agentLoop: AgentLoop;
  let testDir: string;
  let fileStore: FileStore;

  const mockRole = {
    id: 'role-timeout',
    name: 'timeout-agent',
    description: 'three-layer timeout test',
    channels: '[]',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function makeTarget() {
    return {
      workUnit: {
        id: 'wu-timeout-1', title: '三层超时测试', scope: 'do work', type: 'task',
        status: 'active', assigneeId: 'agent-1', parentId: null,
        failureType: null, retryCount: 0, timeoutAt: null,
        projectPath: null, metadata: null, claimedAt: null,
        completedAt: null, createdAt: new Date(), updatedAt: new Date(),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('Claude Code CLI version 1.0.0');
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-timeout-'));
    fileStore = new FileStore(testDir);
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
  });

  afterEach(async () => {
    delete process.env.STUDIO_EVENTS_FILE;
    if (agentLoop) {
      agentLoop.stop();
      await Promise.race([
        agentLoop.waitForStop(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 5000);

  it('AgentTask 三层超时数值：墙钟 1800s 兜底 + 静默 300s warn / 600s kill + maxTurns=50', async () => {
    agentLoop = new AgentLoop(mockRole, fileStore);
    await agentLoop.start();

    const result = await (agentLoop as unknown as {
      agentStep(t: unknown): Promise<unknown>;
    }).agentStep(makeTarget());
    expect(result).toBeDefined();

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
    const task = mockExecuteLightweight.mock.calls[0][0] as AgentTask;
    // 健康长步（p90=128s / p99=693s）不被 120s 误杀 —— 墙钟只是 1800s 天花板
    expect(task.timeoutMs).toBe(1_800_000);
    // 静默看门狗判据 = 距最后一次输出间隔（步内最大静默 p99=215s / 极值 305s）
    expect(task.silenceWarnMs).toBe(300_000);
    expect(task.silenceKillMs).toBe(600_000);
    expect(typeof task.onSilenceWarn).toBe('function');
    // maxTurns=50 预算语义不变
    expect(task.parameters?.maxTurns).toBe(50);
    // token 记账不变：本步成功 → metadataUpdates 仍累计 _cumulativeTokens（CLI 未回报按 0 累加）
    const typed = result as { metadataUpdates?: Record<string, unknown> };
    expect(typed.metadataUpdates).toBeDefined();
    expect(typed.metadataUpdates!._cumulativeTokens).toBe(0);
    // #67 尾巴：lastInputTokens 不再落账
    expect('lastInputTokens' in typed.metadataUpdates!).toBe(false);
  });

  it('静默 warn → logger.warn + workunit:step_silence 事件落事件流', async () => {
    const eventsFile = path.join(testDir, 'studio-events.jsonl');
    process.env.STUDIO_EVENTS_FILE = eventsFile;

    agentLoop = new AgentLoop(mockRole, fileStore);
    await agentLoop.start();
    await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep(makeTarget());

    const task = mockExecuteLightweight.mock.calls[0][0] as AgentTask;
    task.onSilenceWarn!(320_000);

    // fire-and-forget 写盘，轮询落盘
    const deadline = Date.now() + 2000;
    let events: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      if (fs.existsSync(eventsFile)) {
        events = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n')
          .filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
        if (events.some((e) => e.type === 'workunit:step_silence')) break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const evt = events.find((e) => e.type === 'workunit:step_silence');
    expect(evt).toBeDefined();
    const payload = typeof evt!.payload === 'string' ? JSON.parse(evt!.payload) : evt!.payload;
    expect(payload.workUnitId).toBe('wu-timeout-1');
    expect(payload.silentMs).toBe(320_000);
  });
});

describe('#171 #67 尾巴：extractInputTokens / lastInputTokens 残留全删', () => {
  const readSrc = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

  it('agent-loop 不再导出 extractInputTokens', () => {
    expect('extractInputTokens' in agentLoopModule).toBe(false);
  });

  it('parser / 类型字段 / metadata 清理清单无残留', () => {
    expect(readSrc('../loop/agent-loop-parsers.ts')).not.toMatch(/extractInputTokens/);
    expect(readSrc('../loop/agent-loop.ts')).not.toMatch(/extractInputTokens|lastInputTokens/);
    expect(readSrc('../../workunit/workunit.types.ts')).not.toMatch(/lastInputTokens/);
    expect(readSrc('../../workunit/wu-metadata.ts')).not.toMatch(/lastInputTokens/);
  });
});
