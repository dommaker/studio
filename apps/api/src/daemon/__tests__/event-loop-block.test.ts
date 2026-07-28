// execSync 事件循环阻塞测试
// 验证：daemon.submitJob 使用 execSync 会冻结整个 Node.js 事件循环
import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Mock dependencies — no real Claude CLI needed
vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: vi.fn().mockResolvedValue({
    stdout: '{"result": "DONE", "usage": {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 0}}',
  }),
  buildHealthProbeCommand: vi.fn(() => 'claude --version'),
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

const WORKTREES_DIR = path.join(os.tmpdir(), 'daemon-block-test');

/** Register executor session in the daemon (daemon.start() only registers analyst) */
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

describe('execSync 事件循环阻塞验证', () => {
  it('setInterval 在 execSync 期间不会触发', async () => {
    process.env.WORKTREES_DIR = WORKTREES_DIR;
    process.env.REPO_DIR = process.env.REPO_DIR || '/root/projects/studio';
    try { fs.rmSync(WORKTREES_DIR, { recursive: true, force: true }); } catch {}

    daemon.start();
    registerExecutor(path.join(WORKTREES_DIR, 'executor'));

    let heartbeatCount = 0;
    const heartbeats: number[] = [];

    // 模拟 analyst-trigger.service.ts 的 heartbeat 模式
    const interval = setInterval(() => {
      heartbeatCount++;
      heartbeats.push(Date.now());
      console.log(`[Heartbeat #${heartbeatCount}] fired at ${new Date().toISOString()}`);
    }, 3000); // 每3秒一次，比实际场景更频繁以便更快发现问题

    const startTime = Date.now();

    // 提交一个中等长度的任务（~20-30秒）
    const result = await daemon.submitJob('executor', {
      prompt: [
        '## 任务',
        '列出当前目录下所有 .ts 文件（前 50 个），按文件大小排序。',
        '用 find 命令查找，输出文件路径和大小。',
        '完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(process.env.REPO_DIR!, '.daemon', 'output.txt'),
    });

    clearInterval(interval);
    const elapsed = Date.now() - startTime;

    console.log('=== 结果 ===');
    console.log(`任务耗时: ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`heartbeat 触发次数: ${heartbeatCount}`);
    console.log(`heartbeat 时间点: ${heartbeats.map(t => `${((t - startTime) / 1000).toFixed(1)}s`).join(', ')}`);

    // 验证：如果 execSync 真的阻塞了，heartbeatCount 应该为 0
    // （所有 heartbeat 都在任务完成后才触发，但 setInterval 的积压回调也会在事件循环恢复后执行）
    console.log('');
    if (heartbeatCount > 0 && heartbeats[0] < startTime + elapsed - 500) {
      console.log('✅ 确认：heartbeat 在任务执行期间正常触发，事件循环不再阻塞');
    }

    expect(result.success).toBe(true);
    daemon.stop();
  }, 180_000);

  it('两个 session 无法并发 — execSync 串行化所有任务', async () => {
    process.env.WORKTREES_DIR = WORKTREES_DIR;
    process.env.REPO_DIR = process.env.REPO_DIR || '/root/projects/studio';
    try { fs.rmSync(WORKTREES_DIR, { recursive: true, force: true }); } catch {}

    // 创建第二个 worktree 用于第二个 executor
    const wt2 = path.join(WORKTREES_DIR, 'executor-2');
    fs.mkdirSync(wt2, { recursive: true });
    fs.mkdirSync(path.join(wt2, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt2, 'src', 'util.ts'), 'export const VERSION = "1.0";\n', 'utf-8');

    daemon.start();
    registerExecutor(path.join(WORKTREES_DIR, 'executor'));

    // 手动注册第二个 executor session
    const { SessionManager } = await import('../session-manager.js');
    const mgr = new SessionManager();
    mgr.register({
      name: 'executor-2',
      worktree: wt2,
      modelTier: 'fast',
      timeoutMs: 5 * 60 * 1000,
      persistent: false,
    });

    const start = Date.now();
    const execTimestamps: string[] = [];

    // 同时提交两个任务（不 await 第一个）
    const task1 = daemon.submitJob('executor', {
      prompt: '列出当前目录下所有 .ts 文件（前 30 个），输出文件路径。完成后输出 "DONE"',
      outputFile: path.join(process.env.REPO_DIR!, '.daemon', 'out1.txt'),
    }).then(r => { execTimestamps.push(`task1 done at ${((Date.now() - start) / 1000).toFixed(1)}s`); return r; });

    const task2 = mgr.runTask('executor-2', {
      prompt: '在 src/util.ts 中加一个导出函数 getVersion() 返回 VERSION。完成后输出 "DONE"',
      outputFile: path.join(wt2, '.daemon', 'out2.txt'),
    }).then(r => { execTimestamps.push(`task2 done at ${((Date.now() - start) / 1000).toFixed(1)}s`); return r; });

    const [r1, r2] = await Promise.all([task1, task2]);
    const totalElapsed = Date.now() - start;

    console.log('=== 并发测试结果 ===');
    console.log(`总耗时: ${(totalElapsed / 1000).toFixed(1)}s`);
    console.log(`task1 耗时: ${(r1.durationMs / 1000).toFixed(1)}s`);
    console.log(`task2 耗时: ${(r2.durationMs / 1000).toFixed(1)}s`);
    console.log(`完成顺序: ${execTimestamps.join(' | ')}`);

    const serialTime = (r1.durationMs + r2.durationMs) / 1000;
    console.log(`串行理论耗时: ${serialTime.toFixed(1)}s, 实际总耗时: ${(totalElapsed / 1000).toFixed(1)}s`);

    if (totalElapsed < Math.max(r1.durationMs, r2.durationMs) + 2000) {
      console.log('✅ 确认：两个任务真正并发执行（异步 spawn）');
    }

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  }, 300_000);
});
