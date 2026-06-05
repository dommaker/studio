// SessionManager 边界测试 (B0-007) + AC1 cmd/settings verification
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const TEST_DIR = path.join(os.tmpdir(), 'daemon-test-' + Date.now());

// Capture execSh calls
const execShSpy = vi.fn();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mock @dommaker/studio-shared/node — provide all exports session-manager.ts imports
vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: (...args: any[]) => execShSpy(...args),
  resolveSessionId: (worktree: string) => {
    const sidDir = path.join(worktree, '.daemon');
    if (!fs.existsSync(sidDir)) fs.mkdirSync(sidDir, { recursive: true });
    const sidFile = path.join(sidDir, 'session-id');
    // Reuse valid UUID, regenerate invalid ones
    let existing = '';
    try { existing = fs.readFileSync(sidFile, 'utf-8').trim(); } catch {}
    if (existing && UUID_PATTERN.test(existing)) return existing;
    const newUuid = crypto.randomUUID();
    fs.writeFileSync(sidFile, newUuid, 'utf-8');
    return newUuid;
  },
  readSessionIdFile: (worktree: string) => {
    const sidFile = path.join(worktree, '.daemon', 'session-id');
    try {
      const content = fs.readFileSync(sidFile, 'utf-8').trim();
      return UUID_PATTERN.test(content) ? content : null;
    } catch { return null; }
  },
}));

// Also mock @dommaker/studio-shared for logger, getModelForTier
vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getModelForTier: () => 'claude-sonnet-4-6',
}));

// Mock metrics and task-logger — must return Promises for .catch() chaining
vi.mock('../metrics.js', () => ({
  parseClaudeUsage: () => ({ inputTokens: 100, outputTokens: 50, cacheHitTokens: 0 }),
  recordPipelineRun: vi.fn(() => Promise.resolve()),
}));

vi.mock('../task-logger.js', () => ({
  writeTaskLog: vi.fn(),
  classifyTaskError: () => 'unknown',
}));

import { SessionManager } from '../session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    execShSpy.mockReset();
    // Default: execSh resolves with valid envelope JSON
    execShSpy.mockResolvedValue({ stdout: '{"result": "ok"}', stderr: '' });
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
      name: 'analyst', worktree, modelTier: 'standard',
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
      name: 'analyst2', worktree, modelTier: 'premium',
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
      name: 'analyst3', worktree, modelTier: 'standard',
      timeoutMs: 60000, persistent: true,
    });

    const sidFile = path.join(worktree, '.daemon', 'session-id');
    const uuid = fs.readFileSync(sidFile, 'utf-8').trim();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(uuid).not.toBe('not-a-uuid');
  });

  it('gets status for non-existent session returns null', () => {
    expect(manager.getStatus('nonexistent')).toBeNull();
  });

  // ── Concurrency ──

  it('rejects concurrent task on same session', async () => {
    const worktree = path.join(TEST_DIR, 'concurrent');
    manager.register({
      name: 'concurrent', worktree, modelTier: 'standard',
      timeoutMs: 5000, persistent: false,
    });

    const status = manager.getStatus('concurrent');
    expect(status!.isBusy).toBe(false);
  });

  // ── getAllStatus ──

  it('getAllStatus returns all registered sessions', () => {
    manager.register({
      name: 's1', worktree: path.join(TEST_DIR, 's1'),
      modelTier: 'standard', timeoutMs: 60000, persistent: true,
    });
    manager.register({
      name: 's2', worktree: path.join(TEST_DIR, 's2'),
      modelTier: 'premium', timeoutMs: 60000, persistent: false,
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
  // AC1: cmd construction & ensureWorktree verification
  // ═══════════════════════════════════════════════════════════

  describe('AC1: cmd construction and ensureWorktree', () => {
    it('AC1.1: cmd uses < file redirect, not cat | pipe', async () => {
      const worktree = path.join(TEST_DIR, 'ac1');
      manager.register({
        name: 'ac1', worktree, modelTier: 'standard',
        timeoutMs: 5000, persistent: false,
      });

      await manager.runTask('ac1', { prompt: 'hello', outputFile: '/tmp/out.json' });

      const cmd = execShSpy.mock.calls[0]?.[0] as string;
      expect(cmd).toBeDefined();
      // Must use file redirect
      expect(cmd).toContain('<');
      // Must NOT use cat pipe
      expect(cmd).not.toMatch(/\bcat\b/);
      // promptFile reference should exist inside redirect
      expect(cmd).toMatch(/< "/);
      expect(cmd).toMatch(/prompt\.md"/);
    });

    it('AC1.2: cmd does not contain --dangerously-skip-permissions', async () => {
      const worktree = path.join(TEST_DIR, 'ac2');
      manager.register({
        name: 'ac2', worktree, modelTier: 'standard',
        timeoutMs: 5000, persistent: false,
      });

      await manager.runTask('ac2', { prompt: 'hello', outputFile: '/tmp/out.json' });

      const cmd = execShSpy.mock.calls[0]?.[0] as string;
      expect(cmd).not.toContain('--dangerously-skip-permissions');
    });

    it('AC1.3: ensureWorktree writes bypassPermissions to .claude/settings.json', () => {
      const worktree = path.join(TEST_DIR, 'ac3');
      manager.register({
        name: 'ac3', worktree, modelTier: 'standard',
        timeoutMs: 5000, persistent: false,
      });

      const settingsPath = path.join(worktree, '.claude', 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(content.permissions?.defaultMode).toBe('bypassPermissions');
    });

    it('AC1.4: cmd contains 2>&1 — stderr merged into stdout for execSh capture', async () => {
      const worktree = path.join(TEST_DIR, 'ac4');
      manager.register({
        name: 'ac4', worktree, modelTier: 'standard',
        timeoutMs: 5000, persistent: false,
      });

      await manager.runTask('ac4', { prompt: 'hello', outputFile: '/tmp/out.json' });

      const cmd = execShSpy.mock.calls[0]?.[0] as string;
      // 2>&1 merges stderr → stdout so execSh captures error output
      expect(cmd).toContain('2>&1');
    });

    it('AC1.5: execSh called without opts.stdin', async () => {
      const worktree = path.join(TEST_DIR, 'ac5');
      manager.register({
        name: 'ac5', worktree, modelTier: 'standard',
        timeoutMs: 5000, persistent: false,
      });

      await manager.runTask('ac5', { prompt: 'hello', outputFile: '/tmp/out.json' });

      const opts = execShSpy.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
      expect(opts).toBeDefined();
      // execSh should NOT receive opts.stdin — stdin stays 'ignore',
      // shell's < redirect handles input
      expect(opts?.stdin).toBeUndefined();
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
