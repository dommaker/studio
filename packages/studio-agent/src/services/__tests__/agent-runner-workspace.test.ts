/**
 * F6: executeLightweight 执行 cwd 绑定
 *
 * task.parameters.workspaceRoot（由 AgentLoop 从 WorkUnit 绑定的 workspace 解析）
 * → resolveWorkspace Priority 1 直接以该目录为 worktree → spawn CLI 的 cwd。
 * mock execSh（spawn 层），真实跑 resolveWorkspace 链路。
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

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    studioEvent: { create: vi.fn().mockResolvedValue({}) },
    resolution: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: { loadAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../output-capture.js', () => ({
  readProgress: vi.fn().mockReturnValue({ allComplete: true, testResults: { failed: 0 }, sessionCount: 1 }),
  collectOutputFiles: vi.fn().mockResolvedValue([]),
  recordSessionMetrics: vi.fn(),
  emitSessionStart: vi.fn(),
  emitSessionEnd: vi.fn(),
  emitToolCall: vi.fn(),
  emitFileChange: vi.fn(),
  recordExecutionError: vi.fn(),
  getConstraintMeta: vi.fn().mockResolvedValue({ hash: 'abc', size: 100 }),
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  beforeAgentExecute: vi.fn().mockResolvedValue({ prompt: 'enhanced prompt', blocked: false }),
  buildAgentConstraintPrompt: vi.fn().mockResolvedValue('constraint prompt'),
}));

import { AgentRunner } from '../agent-runner.js';
import type { AgentTask } from '../session-manager.js';

/** 最小 stream-json stdout（result 事件 → success） */
function buildStreamStdout(): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-f6' }),
    JSON.stringify({ type: 'result', result: 'done', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join('\n');
}

describe('F6: executeLightweight workspace cwd', () => {
  let wsRoot: string;
  let worktreesDir: string;
  let runner: AgentRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSh.mockResolvedValue({ stdout: buildStreamStdout() });
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f6-ws-root-'));
    worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f6-worktrees-'));
    runner = new AgentRunner({ worktreesDir, repoDir: wsRoot });
  });

  afterEach(() => {
    fs.rmSync(wsRoot, { recursive: true, force: true });
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  });

  function makeTask(): AgentTask {
    return {
      id: 'wu-f6-1',
      executionId: `exec-f6-${Date.now()}`,
      provider: 'claude',
      prompt: 'do something',
      parameters: {
        workspaceRoot: wsRoot,
        workUnitId: 'wu-f6-1',
        agentProfileId: 'role-f6',
      },
      timeoutMs: 5_000,
    };
  }

  test('bound workspaceRoot → CLI spawned with cwd = workspace root', async () => {
    const result = await runner.executeLightweight(makeTask());

    expect(result.success).toBe(true);
    // worktree 直接解析为绑定的工程目录（repo-path-direct，无 git worktree 创建）
    expect(result.worktree).toBe(wsRoot);
    // 真正的 CLI spawn：cmd 以 cd "<wsRoot>" 开头，opts.cwd = wsRoot
    const spawnCall = mockExecSh.mock.calls.find(
      ([cmd, opts]: [string, { cwd?: string }]) => opts?.cwd === wsRoot && String(cmd).startsWith('cd '),
    );
    expect(spawnCall).toBeTruthy();
    expect(String(spawnCall![0])).toContain(`cd "${wsRoot}"`);
    // 没有发生 git worktree add（worktree 隔离只服务 daemon 路径）
    const gitWorktreeCall = mockExecSh.mock.calls.find(
      ([cmd]: [string]) => String(cmd).includes('git worktree add'),
    );
    expect(gitWorktreeCall).toBeUndefined();
  });
});
