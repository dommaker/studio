/**
 * runner-lightweight 单元测试（轻量单 session 执行）
 *
 * mock execSh（spawn 层）与 output-capture，真实跑 workspace 解析（Priority 1）、
 * prompt 增强、session 续接参数注入、stream-json 结果解析链路。
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { mockExecSh } = vi.hoisted(() => ({
  mockExecSh: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return { ...actual, execSh: mockExecSh };
});

vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: { load: vi.fn().mockReturnValue([]), formatForPrompt: vi.fn().mockReturnValue('') },
}));

vi.mock('../output-capture.js', () => ({
  readProgress: vi.fn().mockReturnValue(null),
  collectOutputFiles: vi.fn().mockResolvedValue([]),
  recordSessionMetrics: vi.fn(),
  emitSessionStart: vi.fn(),
  emitSessionEnd: vi.fn(),
  emitToolCall: vi.fn(),
  emitFileChange: vi.fn(),
  getConstraintMeta: vi.fn().mockResolvedValue({ hash: 'abc', size: 100 }),
}));

import { executeLightweightSession } from '../runner-lightweight.js';
import type { RunnerExecutionState } from '../types.js';
import { emitSessionStart, emitSessionEnd } from '../output-capture.js';
import type { AgentTask } from '../types.js';

function buildStreamStdout(result: unknown): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-lw-1' }),
    JSON.stringify({ type: 'result', ...(result as object) }),
  ].join('\n');
}

describe('executeLightweightSession', () => {
  let wsRoot: string;
  let worktreesDir: string;
  let state: RunnerExecutionState;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSh.mockImplementation(async (cmd: string | unknown) => {
      const c = String(cmd);
      if (c.includes('df -h')) return { stdout: 'Available: 50G' };
      if (c.includes('git rev-parse')) return { stdout: '/fake/.git' };
      if (c.startsWith('cd ')) return { stdout: buildStreamStdout({ result: 'done', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }) };
      return { stdout: 'OK' };
    });
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-ws-root-'));
    worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-worktrees-'));
    state = {
      config: { worktreesDir, repoDir: wsRoot },
      runningProcesses: new Map(),
    };
  });

  afterEach(() => {
    fs.rmSync(wsRoot, { recursive: true, force: true });
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  });

  function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
    return {
      id: 'wu-lw-1',
      executionId: `exec-lw-${Date.now()}`,
      provider: 'claude',
      prompt: 'do something',
      parameters: { workspaceRoot: wsRoot, workUnitId: 'wu-lw-1' },
      ...overrides,
    };
  }

  function findSpawnCall(): [string, {
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    killProcessGroup?: boolean;
    silence?: { warnMs?: number; killMs: number; onWarn?: (silentMs: number) => void };
  }] {
    const call = mockExecSh.mock.calls.find(([cmd]: [string]) => String(cmd).startsWith('cd '));
    expect(call).toBeTruthy();
    return call as [string, { env?: Record<string, string | undefined>; timeoutMs?: number }];
  }

  test('成功：outputText/usage/sessionIds 透出，会话续接与 WORKUNIT env 注入', async () => {
    const task = makeTask({ parameters: { workspaceRoot: wsRoot, workUnitId: 'wu-lw-1', sessionId: 'sess-9', sessionResume: true } });
    const result = await executeLightweightSession(state, task);

    expect(result.success).toBe(true);
    expect(result.outputText).toBe('done');
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.sessionCount).toBe(1);
    expect(result.sessionIds).toEqual([task.executionId]);
    expect(result.worktree).toBe(wsRoot);

    const [cmd, opts] = findSpawnCall();
    expect(cmd).toContain('--resume sess-9');
    expect(opts.env?.STUDIO_WORKUNIT_ID).toBe('wu-lw-1');
    // prompt 落盘（含 knowledgeContext 增强位置）
    expect(fs.existsSync(path.join(wsRoot, '.daemon', 'prompt.md'))).toBe(true);
    expect(state.runningProcesses.size).toBe(0);
  });

  test('timeoutMs：task.timeoutMs 覆盖优先，缺省回退扁平默认 30min', async () => {
    await executeLightweightSession(state, makeTask({ timeoutMs: 5_000 }));
    expect(findSpawnCall()[1].timeoutMs).toBe(5_000);

    mockExecSh.mockClear();
    mockExecSh.mockImplementation(async (cmd: string | unknown) => {
      const c = String(cmd);
      if (c.includes('df -h')) return { stdout: 'Available: 50G' };
      if (c.includes('git rev-parse')) return { stdout: '/fake/.git' };
      if (c.startsWith('cd ')) return { stdout: buildStreamStdout({ result: 'done', is_error: false }) };
      return { stdout: 'OK' };
    });
    await executeLightweightSession(state, makeTask());
    expect(findSpawnCall()[1].timeoutMs).toBe(30 * 60 * 1000);
  });

  test('result is_error → 失败返回但保留 usage', async () => {
    mockExecSh.mockResolvedValue({ stdout: buildStreamStdout({ result: 'bad thing', is_error: true, usage: { input_tokens: 3, output_tokens: 1 } }) });
    const result = await executeLightweightSession(state, makeTask());

    expect(result.success).toBe(false);
    expect(result.error).toBe('bad thing');
    expect(result.usage?.inputTokens).toBe(3);
    expect(result.sessionCount).toBe(1);
  });

  test('#171（#54 决议）：静默看门狗与进程组杀透传 execSh', async () => {
    const onSilenceWarn = vi.fn();
    await executeLightweightSession(state, makeTask({
      timeoutMs: 1_800_000,
      silenceWarnMs: 300_000,
      silenceKillMs: 600_000,
      onSilenceWarn,
    }));
    const opts = findSpawnCall()[1];
    expect(opts.timeoutMs).toBe(1_800_000);
    expect(opts.killProcessGroup).toBe(true);
    expect(opts.silence).toEqual({ warnMs: 300_000, killMs: 600_000, onWarn: onSilenceWarn });
  });

  test('#171：未配 silenceKillMs → 不开看门狗，但进程组杀恒开（孤儿防护）', async () => {
    await executeLightweightSession(state, makeTask());
    const opts = findSpawnCall()[1];
    expect(opts.killProcessGroup).toBe(true);
    expect(opts.silence).toBeUndefined();
  });

  test('#174：emitSessionStart/End 第 4 参透传 parameters 的 workUnitId/transcriptPath', async () => {
    const task = makeTask({
      parameters: { workspaceRoot: wsRoot, workUnitId: 'wu-lw-7', transcriptPath: '/tmp/transcripts/wu-lw-7.jsonl' },
    });
    await executeLightweightSession(state, task);
    expect(emitSessionStart).toHaveBeenCalledWith(task.executionId, task.executionId, 1, {
      workUnitId: 'wu-lw-7',
      transcriptPath: '/tmp/transcripts/wu-lw-7.jsonl',
    });
  });

  test('#174：parameters 无 workUnitId/transcriptPath → 第 4 参两字段均 undefined', async () => {
    const task = makeTask({ parameters: { workspaceRoot: wsRoot } });
    await executeLightweightSession(state, task);
    expect(emitSessionStart).toHaveBeenCalledWith(task.executionId, task.executionId, 1, {
      workUnitId: undefined,
      transcriptPath: undefined,
    });
  });

  test('#174：失败路径 emitSessionEnd 同样透传 extras', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (String(cmd).startsWith('cd ')) {
        throw Object.assign(new Error('cli gone'), { stdout: Buffer.from('partial'), stderr: Buffer.from('') });
      }
      return { stdout: '' };
    });
    const task = makeTask({
      parameters: { workspaceRoot: wsRoot, workUnitId: 'wu-lw-8', transcriptPath: '/tmp/transcripts/wu-lw-8.jsonl' },
    });
    await executeLightweightSession(state, task);
    expect(emitSessionEnd).toHaveBeenCalledWith(task.executionId, task.executionId, 1, {
      workUnitId: 'wu-lw-8',
      transcriptPath: '/tmp/transcripts/wu-lw-8.jsonl',
    });
  });

  test('execSh 抛错 → 失败返回并记录执行错误', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (String(cmd).startsWith('cd ')) {
        throw Object.assign(new Error('cli gone'), { stdout: Buffer.from('partial'), stderr: Buffer.from('') });
      }
      return { stdout: '' };
    });
    const result = await executeLightweightSession(state, makeTask());

    expect(result.success).toBe(false);
    expect(result.error).toBe('cli gone');
    expect(result.failureLog).toBe('partial');
    expect(emitSessionEnd).toHaveBeenCalledTimes(1);
    expect(state.runningProcesses.size).toBe(0);
    // #565 AC6: 无已知特征 → 无 failureClass（行为与现状一致）
    expect(result.failureClass).toBeUndefined();
  });

  test('#565 AC6：catch 路径命中分类 → failureClass + error 指引前缀', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (String(cmd).startsWith('cd ')) {
        throw Object.assign(new Error('Command failed'), { code: 1, stdout: Buffer.from('Not logged in'), stderr: Buffer.from('') });
      }
      return { stdout: '' };
    });
    const result = await executeLightweightSession(state, makeTask({ provider: 'codex' }));

    expect(result.success).toBe(false);
    expect(result.failureClass).toBeDefined();
    expect(result.failureClass!.category).toBe('auth');
    expect(result.failureClass!.guidance).toContain('codex login');
    expect(result.error).toMatch(/^\[auth\] /);
    expect(result.error).toContain('codex login');
  });

  test('#565 AC6：is_error 路径命中分类 → failureClass + error 指引前缀', async () => {
    // 注：mockResolvedValue 全覆盖（含前置检查的 df -h）→ stdout 需带 usage 数字避免磁盘检查误判
    mockExecSh.mockResolvedValue({ stdout: buildStreamStdout({ result: 'Error: Invalid API key', is_error: true, usage: { input_tokens: 30, output_tokens: 10 } }) });
    const result = await executeLightweightSession(state, makeTask());

    expect(result.success).toBe(false);
    expect(result.failureClass!.category).toBe('auth');
    expect(result.error).toMatch(/^\[auth\] /);
    expect(result.error).toContain('claude login');
  });
});
