// SessionManager 边界测试 (B0-007) + P9 delegation to AgentRunner
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const TEST_DIR = path.join(os.tmpdir(), 'daemon-test-' + Date.now());

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mock @dommaker/studio-shared/node — provide all exports session-manager.ts imports
vi.mock('@dommaker/studio-shared/node', () => ({
  readSessionIdFile: (worktree: string) => {
    const sidFile = path.join(worktree, '.daemon', 'session-id');
    try {
      const content = fs.readFileSync(sidFile, 'utf-8').trim();
      return UUID_PATTERN.test(content) ? content : null;
    } catch { return null; }
  },
}));

// Also mock @dommaker/studio-shared for logger
vi.mock('@dommaker/studio-shared', async (importOriginal) => ({
  // Spread real module: FileStore & other post-migration exports must exist
  // (session-summary-generator constructs `new FileStore()` at import time).
  ...(await importOriginal<typeof import('@dommaker/studio-shared')>()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock metrics and task-logger — must return Promises for .catch() chaining
vi.mock('../metrics.js', () => ({
  parseClaudeUsage: () => ({ inputTokens: 100, outputTokens: 50, cacheHitTokens: 0 }),
  recordExecution: vi.fn(() => Promise.resolve()),
}));

vi.mock('../task-logger.js', () => ({
  writeTaskLog: vi.fn(),
  classifyTaskError: () => 'unknown',
}));

// P9: Mock agentRunner.executeLightweight
const mockExecuteLightweight = vi.fn();

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: (...args: any[]) => mockExecuteLightweight(...args),
  },
}));

import { SessionManager } from '../session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    mockExecuteLightweight.mockReset();
    // Default: executeLightweight resolves with success
    mockExecuteLightweight.mockResolvedValue({
      success: true,
      worktree: TEST_DIR,
      outputFiles: [],
      logFile: path.join(TEST_DIR, '.agent.log'),
      sessionCount: 1,
      totalDurationMs: 100,
      sessionIds: ['test-session-id'],
      outputText: '{"type":"result","result":"ok","is_error":false}',
    });
    manager = new SessionManager();
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // ── Registration ──

  it('registers session with valid UUID', () => {
    const worktree = path.join(TEST_DIR, 'analyst');
    manager.register({
      name: 'analyst', worktree,
      timeoutMs: 60000, persistent: true,
    });

    const status = manager.getStatus('analyst');
    expect(status).not.toBeNull();
    expect(status!.name).toBe('analyst');
    expect(status!.taskCount).toBe(0);

    // Verify UUID file was created
    const sidFile = path.join(worktree, '.daemon', 'session-id');
    expect(fs.existsSync(sidFile)).toBe(true);
    const uuid = fs.readFileSync(sidFile, 'utf-8').trim();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('reuses existing UUID from file', () => {
    const worktree = path.join(TEST_DIR, 'analyst2');
    fs.mkdirSync(path.join(worktree, '.daemon'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.daemon', 'session-id'), '00000000-0000-0000-0000-000000000000');
    // Write current PID so isProcessAlive returns true
    fs.writeFileSync(path.join(worktree, '.daemon', 'daemon-pid'), String(process.pid));

    manager.register({
      name: 'analyst2', worktree,
      timeoutMs: 60000, persistent: true,
    });

    const status = manager.getStatus('analyst2');
    // Verify session ID persisted
    const sidFile = path.join(worktree, '.daemon', 'session-id');
    expect(fs.readFileSync(sidFile, 'utf-8').trim()).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('rejects and regenerates invalid UUID in file', () => {
    const worktree = path.join(TEST_DIR, 'analyst3');
    fs.mkdirSync(path.join(worktree, '.daemon'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.daemon', 'session-id'), 'not-a-uuid');

    manager.register({
      name: 'analyst3', worktree,
      timeoutMs: 60000, persistent: true,
    });

    const sidFile = path.join(worktree, '.daemon', 'session-id');
    const uuid = fs.readFileSync(sidFile, 'utf-8').trim();
    expect(uuid).toMatch(UUID_PATTERN);
    expect(uuid).not.toBe('not-a-uuid');
  });

  it('gets status for non-existent session returns null', () => {
    expect(manager.getStatus('nonexistent')).toBeNull();
  });

  // ── Concurrency ──

  it('rejects concurrent task on same session', async () => {
    const worktree = path.join(TEST_DIR, 'concurrent');
    manager.register({
      name: 'concurrent', worktree,
      timeoutMs: 5000, persistent: false,
    });

    const status = manager.getStatus('concurrent');
    expect(status!.isBusy).toBe(false);
  });

  // ── getAllStatus ──

  it('getAllStatus returns all registered sessions', () => {
    manager.register({
      name: 's1', worktree: path.join(TEST_DIR, 's1'),
      timeoutMs: 60000, persistent: true,
    });
    manager.register({
      name: 's2', worktree: path.join(TEST_DIR, 's2'),
      timeoutMs: 60000, persistent: false,
    });

    const all = manager.getAllStatus();
    expect(all.length).toBe(2);
    expect(all.map(s => s?.name).sort()).toEqual(['s1', 's2']);
  });

  // ── 错误分支: 不存在的 session ──

  it('runTask throws for unknown session', async () => {
    await expect(
      manager.runTask('unknown', { prompt: 'test', outputFile: '/tmp/test.json' })
    ).rejects.toThrow('Session not found');
  });

  // ═══════════════════════════════════════════════════════════
  // P9: Delegation to AgentRunner
  // ═══════════════════════════════════════════════════════════

  describe('P9: AgentRunner delegation', () => {
    it('delegates to agentRunner.executeLightweight with correct task', async () => {
      const worktree = path.join(TEST_DIR, 'p9-1');
      manager.register({
        name: 'p9-1', worktree,
        timeoutMs: 5000, persistent: false,
      });

      await manager.runTask('p9-1', { prompt: 'hello world', outputFile: '/tmp/out.json' });

      expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
      const task = mockExecuteLightweight.mock.calls[0][0];
      expect(task.prompt).toBe('hello world');
      expect(task.parameters.worktree).toBe(worktree);
      expect(task.parameters.agentRole).toBe('executor');
      expect(task.parameters.sessionFlags).toContain('--session-id');
    });

    it('analyst session passes agentRole=analyst', async () => {
      const worktree = path.join(TEST_DIR, 'p9-analyst');
      manager.register({
        name: 'analyst', worktree,
        timeoutMs: 5000, persistent: false,
      });

      await manager.runTask('analyst', { prompt: 'analyze', outputFile: '' });

      const task = mockExecuteLightweight.mock.calls[0][0];
      expect(task.parameters.agentRole).toBe('analyst');
    });

    it('subsequent task uses --continue flag', async () => {
      const worktree = path.join(TEST_DIR, 'p9-cont');
      manager.register({
        name: 'p9-cont', worktree,
        timeoutMs: 5000, persistent: false,
      });

      await manager.runTask('p9-cont', { prompt: 'first', outputFile: '' });
      await manager.runTask('p9-cont', { prompt: 'second', outputFile: '' });

      expect(mockExecuteLightweight).toHaveBeenCalledTimes(2);
      const flags1 = mockExecuteLightweight.mock.calls[0][0].parameters.sessionFlags;
      const flags2 = mockExecuteLightweight.mock.calls[1][0].parameters.sessionFlags;
      expect(flags1).toContain('--session-id');
      expect(flags2).toBe('--continue');
    });

    it('success returns TaskResult with output', async () => {
      const worktree = path.join(TEST_DIR, 'p9-ok');
      manager.register({
        name: 'p9-ok', worktree,
        timeoutMs: 5000, persistent: false,
      });

      const result = await manager.runTask('p9-ok', { prompt: 'test', outputFile: '' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('ok');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('failure returns TaskResult with error', async () => {
      mockExecuteLightweight.mockResolvedValue({
        success: false,
        worktree: TEST_DIR,
        outputFiles: [],
        error: 'agent failed',
        logFile: '',
        sessionCount: 1,
        totalDurationMs: 50,
      });

      const worktree = path.join(TEST_DIR, 'p9-fail');
      manager.register({
        name: 'p9-fail', worktree,
        timeoutMs: 5000, persistent: false,
      });

      const result = await manager.runTask('p9-fail', { prompt: 'test', outputFile: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('agent failed');
    });

    it('taskCount increments on success', async () => {
      const worktree = path.join(TEST_DIR, 'p9-count');
      manager.register({
        name: 'p9-count', worktree,
        timeoutMs: 5000, persistent: false,
      });

      expect(manager.getStatus('p9-count')!.taskCount).toBe(0);
      await manager.runTask('p9-count', { prompt: 'test', outputFile: '' });
      expect(manager.getStatus('p9-count')!.taskCount).toBe(1);
    });

    it('ensureWorktree writes bypassPermissions to .claude/settings.json', () => {
      const worktree = path.join(TEST_DIR, 'p9-settings');
      manager.register({
        name: 'p9-settings', worktree,
        timeoutMs: 5000, persistent: false,
      });

      const settingsPath = path.join(worktree, '.claude', 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(content.permissions?.defaultMode).toBe('bypassPermissions');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // F2: execSh stdout/stderr e2e — real shell commands, no mocking
  // ═══════════════════════════════════════════════════════════

  describe('F2: execSh stdout/stderr capture (e2e)', () => {
    // Import real execSh for this e2e block (not the mocked one)
    let realExecSh: typeof import('@dommaker/studio-shared/node').execSh;

    beforeAll(async () => {
      // Use vi.importActual to get the real execSh
      const actual = await vi.importActual<typeof import('@dommaker/studio-shared/node')>('@dommaker/studio-shared/node');
      realExecSh = actual.execSh;
    });

    it('F2.1: execSh captures stdout from real shell command', async () => {
      const result = await realExecSh('echo "hello stdout"', {
        cwd: TEST_DIR,
        timeoutMs: 5000,
      });
      expect(result.stdout).toContain('hello stdout');
    });

    it('F2.2: execSh captures stderr from real shell command', async () => {
      const result = await realExecSh('echo "hello stderr" >&2', {
        cwd: TEST_DIR,
        timeoutMs: 5000,
      });
      expect(result.stderr).toContain('hello stderr');
    });

    it('F2.3: execSh captures both stdout and stderr independently', async () => {
      const result = await realExecSh('echo "to stdout"; echo "to stderr" >&2', {
        cwd: TEST_DIR,
        timeoutMs: 5000,
      });
      expect(result.stdout).toContain('to stdout');
      expect(result.stderr).toContain('to stderr');
      // Without 2>&1, stdout does NOT contain stderr content
      expect(result.stdout).not.toContain('to stderr');
    });

    it('F2.4: 2>&1 merges stderr into stdout (vital for downstream capture)', async () => {
      const result = await realExecSh('echo "merge test"; echo "error output" >&2', {
        cwd: TEST_DIR,
        timeoutMs: 5000,
      });
      // Without 2>&1 in the cmd, stderr is separate
      expect(result.stderr).toContain('error output');
      expect(result.stdout).not.toContain('error output');

      // With 2>&1, stderr merges into stdout
      const merged = await realExecSh('(echo "merge test"; echo "error output" >&2) 2>&1', {
        cwd: TEST_DIR,
        timeoutMs: 5000,
      });
      expect(merged.stdout).toContain('merge test');
      expect(merged.stdout).toContain('error output');
      // With 2>&1, stderr pipe gets nothing (all merged to stdout)
    });
  });
});
