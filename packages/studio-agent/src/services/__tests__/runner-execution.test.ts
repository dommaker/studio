/**
 * runner-execution 单元测试（session loop）
 *
 * mock execSh（spawn 层）与 output-capture（事件/指标），真实跑
 * workspace 解析（Priority 1 直通）、prompt 构建、session flag、进度判定链路。
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { mockExecSh, mockResolveWorkspace, mockReadProgress } = vi.hoisted(() => ({
  mockExecSh: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockReadProgress: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    findSddDocById: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return { ...actual, execSh: mockExecSh };
});

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    studioEvent: { create: vi.fn().mockResolvedValue({}) },
    resolution: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: { load: vi.fn().mockReturnValue([]), formatForPrompt: vi.fn().mockReturnValue('') },
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  beforeAgentExecute: vi.fn().mockResolvedValue({ prompt: 'enhanced prompt', blocked: false }),
  buildAgentConstraintPrompt: vi.fn().mockReturnValue('constraint prompt'),
}));

vi.mock('../worktree-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worktree-resolver.js')>();
  return { ...actual, resolveWorkspace: mockResolveWorkspace };
});

vi.mock('../output-capture.js', () => ({
  readProgress: mockReadProgress,
  collectOutputFiles: vi.fn().mockResolvedValue([]),
  recordSessionMetrics: vi.fn(),
  emitSessionStart: vi.fn(),
  emitSessionEnd: vi.fn(),
  emitToolCall: vi.fn(),
  emitFileChange: vi.fn(),
  recordExecutionError: vi.fn(),
  getConstraintMeta: vi.fn().mockResolvedValue({ hash: 'abc', size: 100 }),
}));

import { executeSessionLoop, type RunnerExecutionState } from '../runner-execution.js';
import { emitSessionStart, emitSessionEnd, recordExecutionError } from '../output-capture.js';
import type { AgentTask } from '../session-manager.js';

/** 最小 stream-json stdout（result 事件 → success） */
function buildStreamStdout(): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-loop-1' }),
    JSON.stringify({ type: 'result', result: 'done', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join('\n');
}

describe('executeSessionLoop', () => {
  let wsRoot: string;
  let worktreesDir: string;
  let state: RunnerExecutionState;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSh.mockResolvedValue({ stdout: buildStreamStdout() });
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-ws-root-'));
    worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-worktrees-'));
    // 模拟 resolveWorkspace Priority 1：workspaceRoot 直通
    mockResolveWorkspace.mockImplementation(async ({ task }: { task: AgentTask }) => {
      return (task.parameters?.workspaceRoot as string) || path.join(worktreesDir, task.executionId);
    });
    state = {
      config: { worktreesDir, repoDir: wsRoot, taskTimeoutMinutes: 60, sessionTimeoutMinutes: 30, maxSessions: 5 },
      runningProcesses: new Map(),
    };
  });

  afterEach(() => {
    fs.rmSync(wsRoot, { recursive: true, force: true });
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  });

  function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
    return {
      id: 'task-loop-1',
      executionId: `exec-loop-${Date.now()}`,
      provider: 'claude',
      prompt: 'do something',
      parameters: { workspaceRoot: wsRoot },
      ...overrides,
    };
  }

  function findSpawnCall(): [string, { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number }] {
    const call = mockExecSh.mock.calls.find(
      ([cmd, opts]: [string, { cwd?: string }]) => String(cmd).startsWith('cd ') && opts?.cwd === wsRoot,
    );
    expect(call).toBeTruthy();
    return call as [string, { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number }];
  }

  test('session 1 即 allComplete → 成功返回，spawn 参数正确', async () => {
    mockReadProgress.mockReturnValue({ allComplete: true, completedSteps: ['s1'], testResults: { total: 1, passed: 1, failed: 0 } });
    const task = makeTask();

    const result = await executeSessionLoop(state, task);

    expect(result.success).toBe(true);
    expect(result.sessionCount).toBe(1);
    expect(result.worktree).toBe(wsRoot);
    expect(result.logFile).toBe(path.join(wsRoot, '.agent.log'));
    expect(result.sessionIds).toHaveLength(1);

    const [cmd, opts] = findSpawnCall();
    expect(cmd).toContain(`cd "${wsRoot}" &&`);
    // 首个新 session：--session-id + --name
    expect(cmd).toContain('--session-id');
    expect(cmd).toContain(`--name "executor-${task.executionId.slice(0, 8)}"`);
    expect(opts.env?.STUDIO_EXECUTION_ID).toBe(task.executionId);
    expect(opts.env?.HOME).toBe(`/tmp/agent-loop/${task.executionId}`);
    expect(opts.timeoutMs).toBe(30 * 60 * 1000);

    // 文件桥：REQUIREMENTS.md 与 .agent.log 落盘
    expect(fs.existsSync(path.join(wsRoot, 'REQUIREMENTS.md'))).toBe(true);
    expect(fs.readFileSync(result.logFile, 'utf-8')).toBe(buildStreamStdout());
    // 事件：session start/end 成对
    expect(emitSessionStart).toHaveBeenCalledTimes(1);
    expect(emitSessionEnd).toHaveBeenCalledTimes(1);
    // 进程表在 finally 中清理
    expect(state.runningProcesses.size).toBe(0);
  });

  test('session 1 零进度 → 快速失败', async () => {
    mockReadProgress.mockReturnValue(null);
    const result = await executeSessionLoop(state, makeTask());

    expect(result.success).toBe(false);
    expect(result.sessionCount).toBe(1);
    expect(result.error).toContain('zero progress');
    expect(result.failureLog).toContain('## Session 1 Zero Progress');
  });

  test('workspace 解析失败 → 提前返回 fallback logFile', async () => {
    mockResolveWorkspace.mockRejectedValueOnce(new Error('ws fail'));
    const task = makeTask();

    const result = await executeSessionLoop(state, task);

    expect(result.success).toBe(false);
    expect(result.error).toBe('ws fail');
    expect(result.worktree).toBe('');
    expect(result.logFile).toBe(path.join(worktreesDir, task.executionId, '.agent.log'));
    expect(result.sessionCount).toBe(0);
  });

  test('execSh 失败且 maxSessions=1 → 耗尽快退并记录错误', async () => {
    state.config.maxSessions = 1;
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (String(cmd).startsWith('cd ')) {
        throw Object.assign(new Error('spawn boom'), { stdout: Buffer.from('some output'), stderr: Buffer.from('') });
      }
      return { stdout: '' };
    });

    const result = await executeSessionLoop(state, makeTask());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Max sessions (1) exhausted');
    expect(result.failureLog).toContain('## Session 1 Failure');
    expect(recordExecutionError).toHaveBeenCalledTimes(1);
    expect(emitSessionEnd).toHaveBeenCalledTimes(1);
    expect(state.runningProcesses.size).toBe(0);
  });
});
