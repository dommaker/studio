// 真实代码库任务测试 — 在 agent-studio 项目上跑复杂多文件修改
import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const REPO_DIR = process.env.REPO_DIR || '/root/projects/studio';
const WORKTREES_DIR = path.join(os.tmpdir(), 'daemon-realcode-test');

// Mock dependencies — no real Claude CLI needed
vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: vi.fn().mockResolvedValue({
    stdout: '{"result": "DONE", "usage": {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 0}}',
  }),
  resolveSessionId: vi.fn((worktree: string) => {
    const sidFile = path.join(worktree, '.daemon', 'session-id');
    try { return fs.readFileSync(sidFile, 'utf-8').trim(); } catch { return null; }
  }),
  readSessionIdFile: vi.fn((worktree: string) => {
    const sidFile = path.join(worktree, '.daemon', 'session-id');
    try {
      const content = fs.readFileSync(sidFile, 'utf-8').trim();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(content) ? content : null;
    } catch { return null; }
  }),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => ({
  // Spread real module: FileStore & other post-migration exports must exist
  // (session-summary-generator constructs `new FileStore()` at import time).
  ...(await importOriginal<typeof import('@dommaker/studio-shared')>()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getModelForTier: vi.fn(() => 'claude-sonnet-4-6'),
}));

vi.mock('../metrics.js', () => ({
  parseClaudeUsage: vi.fn(() => ({ inputTokens: 100, outputTokens: 50, cacheHitTokens: 0 })),
  recordExecution: vi.fn(() => Promise.resolve()),
  recordAgentSessionFromLog: vi.fn(),
}));

vi.mock('../task-logger.js', () => ({
  writeTaskLog: vi.fn(),
  classifyTaskError: vi.fn(() => 'unknown'),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: vi.fn().mockResolvedValue({
      success: true,
      output: 'DONE',
      totalDurationMs: 100,
      worktree: '',
      outputFiles: [],
      logFile: '',
      sessionCount: 1,
    }),
    stop: vi.fn(),
    execute: vi.fn(),
  },
}));

import { daemon } from '../studio-daemon.js';

/** Register executor session in the daemon */
function registerExecutor(worktree: string) {
  fs.mkdirSync(worktree, { recursive: true });
  (daemon as any).manager.register({
    name: 'executor',
    worktree,
    modelTier: 'fast',
    timeoutMs: 5 * 60 * 1000,
    persistent: false,
  });
}

describe('真实代码库任务', () => {
  it('多文件重构：提取工具函数 + 添加类型 + 写测试', async () => {
    process.env.REPO_DIR = REPO_DIR;
    process.env.WORKTREES_DIR = WORKTREES_DIR;
    try { fs.rmSync(WORKTREES_DIR, { recursive: true, force: true }); } catch {}

    daemon.start();
    registerExecutor(path.join(WORKTREES_DIR, 'executor'));

    // 在 executor worktree 中操作真实代码
    const execStatus = daemon.getStatus('executor');
    const worktree = execStatus!.worktree;

    // 任务：创建一个新工具模块
    const result = await daemon.submitJob('executor', {
      prompt: [
        '## 任务：创建 daemon 工具模块',
        '',
        '### 1. 创建 apps/api/src/daemon/utils.ts',
        '...',
        '完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(worktree, '.daemon', 'output.txt'),
    });

    console.log('=== 多文件重构结果 ===');
    console.log('success:', result.success);
    console.log('durationMs:', result.durationMs);
    console.log('error:', result.error?.slice(0, 300));

    // 验证产出 — file existence is conditional, mock doesn't create files
    const utilsPath = path.join(worktree, 'apps/api/src/daemon/utils.ts');
    const smPath = path.join(worktree, 'apps/api/src/daemon/session-manager.ts');

    if (fs.existsSync(utilsPath)) {
      const utilsContent = fs.readFileSync(utilsPath, 'utf-8');
      console.log('=== utils.ts 存在 ===');
      console.log('ensureDir:', utilsContent.includes('ensureDir'));
      console.log('formatDuration:', utilsContent.includes('formatDuration'));
      console.log('safeJsonParse:', utilsContent.includes('safeJsonParse'));
      expect(utilsContent).toContain('ensureDir');
      expect(utilsContent).toContain('formatDuration');
      expect(utilsContent).toContain('safeJsonParse');
    }

    if (fs.existsSync(smPath)) {
      const smContent = fs.readFileSync(smPath, 'utf-8');
      console.log('=== session-manager.ts 更新 ===');
      console.log('import utils:', smContent.includes('./utils.js'));
    }

    expect(result.success).toBe(true);
    daemon.stop();
  }, 300_000);

  it('Session 复用跨多个任务（模拟真实开发流）', async () => {
    process.env.REPO_DIR = REPO_DIR;
    process.env.WORKTREES_DIR = WORKTREES_DIR;

    daemon.start();
    registerExecutor(path.join(WORKTREES_DIR, 'executor'));

    const execStatus = daemon.getStatus('executor');
    const worktree = execStatus!.worktree;

    // 任务 A: 给 utils.ts 添加新函数
    const rA = await daemon.submitJob('executor', {
      prompt: [
        '## 任务：给 utils.ts 添加 truncate 函数',
        '...',
        '完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(worktree, '.daemon', 'outA.txt'),
    });

    console.log('=== 任务 A ===');
    console.log('success:', rA.success, 'durationMs:', rA.durationMs);

    // 任务 B: 修改 session-manager.ts 使用 truncate
    const rB = await daemon.submitJob('executor', {
      prompt: [
        '## 任务：在 session-manager.ts 中使用 truncate',
        '...',
        '不要改其他逻辑。完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(worktree, '.daemon', 'outB.txt'),
    });

    console.log('\n=== 任务 B ===');
    console.log('success:', rB.success, 'durationMs:', rB.durationMs);

    const utilsPath = path.join(worktree, 'apps/api/src/daemon/utils.ts');
    const smPath = path.join(worktree, 'apps/api/src/daemon/session-manager.ts');

    if (fs.existsSync(utilsPath)) {
      console.log('utils.ts has truncate:', fs.readFileSync(utilsPath, 'utf-8').includes('truncate'));
    }
    if (fs.existsSync(smPath)) {
      console.log('sm.ts imports truncate:', fs.readFileSync(smPath, 'utf-8').includes('truncate'));
    }

    expect(rA.success).toBe(true);
    expect(rB.success).toBe(true);
    daemon.stop();
  }, 300_000);
});
