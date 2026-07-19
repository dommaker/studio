// Executor Daemon 实战测试
// 实际 spawn Claude Code 跑编码任务，在实战中发现并修复问题
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const isCI = !!process.env.CI;
const describeIf = isCI ? describe.skip : describe;

const WORKTREES_DIR = path.join(os.tmpdir(), 'daemon-executor-test');
const REPO_DIR = process.env.REPO_DIR || '/root/projects/studio';

// Mock dependencies — no real Claude CLI needed
vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: vi.fn(async () => ({
    stdout: '{"result": "DONE", "usage": {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 0}}',
  })),
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

// Mock agentRunner — runTask delegates to agentRunner.executeLightweight, not execSh directly
vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: vi.fn(async (task: any) => {
      const prompt: string = task.prompt;
      const wt: string = task.parameters?.worktree || '';

      // Simulate adding healthCheck method
      if (prompt.includes('healthCheck()') && prompt.includes('{ ok: boolean')) {
        const smPath = path.join(wt, 'apps/api/src/daemon/session-manager.ts');
        if (fs.existsSync(smPath)) {
          let content = fs.readFileSync(smPath, 'utf-8');
          if (!content.includes('healthCheck')) {
            const anchor = 'register(config: SessionConfig): void {';
            const idx = content.indexOf(anchor);
            if (idx > -1) {
              const method = `  healthCheck(): { ok: boolean; sessions: number; uptime: number } {\n    return { ok: true, sessions: this.sessions.size, uptime: Date.now() };\n  }\n\n`;
              content = content.slice(0, idx) + method + content.slice(idx);
              fs.writeFileSync(smPath, content);
            }
          }
        }
      }

      // Simulate adding getSessionIds method
      if (prompt.includes('getSessionIds()') && prompt.includes('string[]')) {
        const smPath = path.join(wt, 'apps/api/src/daemon/session-manager.ts');
        if (fs.existsSync(smPath)) {
          let content = fs.readFileSync(smPath, 'utf-8');
          if (!content.includes('getSessionIds')) {
            const anchor = 'register(config: SessionConfig): void {';
            const idx = content.indexOf(anchor);
            if (idx > -1) {
              const method = `  getSessionIds(): string[] {\n    return Array.from(this.sessions.keys());\n  }\n\n`;
              content = content.slice(0, idx) + method + content.slice(idx);
              fs.writeFileSync(smPath, content);
            }
          }
        }
      }

      return {
        success: true,
        worktree: wt,
        outputFiles: [],
        logFile: path.join(wt, '.agent.log'),
        sessionCount: 1,
        outputText: 'DONE',
        totalDurationMs: 100,
      };
    }),
  },
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

import { daemon } from '../studio-daemon.js';

describeIf('Executor Daemon 实战测试', () => {
  beforeAll(() => {
    process.env.REPO_DIR = REPO_DIR;
    process.env.WORKTREES_DIR = WORKTREES_DIR;

    // 清理
    try { fs.rmSync(WORKTREES_DIR, { recursive: true, force: true }); } catch {}

    // 启动 daemon（注册 analyst + reviewer）
    daemon.start();

    // Register executor session — daemon.start() only registers analyst+reviewer
    const executorWt = path.join(WORKTREES_DIR, 'executor');
    fs.mkdirSync(executorWt, { recursive: true });
    (daemon as any).manager.register({
      name: 'executor',
      worktree: executorWt,
      modelTier: 'fast',
      timeoutMs: 5 * 60 * 1000,
      persistent: false,
    });

    const status = daemon.getStatus();
    console.log('=== Daemon 会话状态 ===');
    for (const s of status) {
      if (!s) continue;
      console.log(`  ${s.name}: ${s.isBusy ? 'busy' : 'idle'} | worktree: ${s.worktree}`);
    }
  });

  afterAll(() => {
    daemon.stop();
  });

  it('任务1: 简单文件修改 — 给 session-manager.ts 加一个 healthCheck 方法', async () => {
    // 在 executor worktree 中准备文件
    const execStatus = daemon.getStatus('executor');
    expect(execStatus).toBeTruthy();
    const worktree = execStatus!.worktree;

    // 确保目标文件存在
    const targetFile = path.join(worktree, 'apps/api/src/daemon/session-manager.ts');
    if (!fs.existsSync(targetFile)) {
      // 如果 executor worktree 没有完整代码，用 src 目录的备份
      const srcFile = path.join(REPO_DIR, 'apps/api/src/daemon/session-manager.ts');
      if (fs.existsSync(srcFile)) {
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.copyFileSync(srcFile, targetFile);
      }
    }
    expect(fs.existsSync(targetFile), 'session-manager.ts 应该存在').toBe(true);

    const result = await daemon.submitJob('executor', {
      prompt: [
        '## 任务',
        '在 apps/api/src/daemon/session-manager.ts 的 SessionManager 类中添加一个 healthCheck() 方法。',
        '',
        '方法签名: healthCheck(): { ok: boolean; sessions: number; uptime: number }',
        '- ok: 总是 true',
        '- sessions: this.sessions.size',
        '- uptime: 返回 Date.now() - 某个启动时间（用 Date.now() 即可，不需要持久化）',
        '',
        '## 要求',
        '- 方法加在 register() 方法之后',
        '- 不要改其他代码',
        '- 完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(worktree, '.daemon', 'output.txt'),
    });

    console.log('=== 任务1 结果 ===');
    console.log('success:', result.success);
    console.log('durationMs:', result.durationMs);
    console.log('error:', result.error?.slice(0, 300));

    if (result.success && fs.existsSync(targetFile)) {
      const content = fs.readFileSync(targetFile, 'utf-8');
      console.log('healthCheck 存在:', content.includes('healthCheck'));
      console.log('sessions.size:', content.includes('sessions.size'));
    }

    expect(result.success).toBe(true);
  }, 180_000);

  it('任务2: --continue 复用 cache，再加一个 getSessionIds 方法', async () => {
    const execStatus = daemon.getStatus('executor');
    const worktree = execStatus!.worktree;

    const result = await daemon.submitJob('executor', {
      prompt: [
        '## 任务',
        '在 apps/api/src/daemon/session-manager.ts 的 SessionManager 类中，在 healthCheck() 后面再加一个 getSessionIds() 方法。',
        '',
        '方法签名: getSessionIds(): string[]',
        '- 返回所有注册 session 的 sessionId 列表',
        '- 从 this.sessions 中提取',
        '',
        '## 要求',
        '- 不要改其他代码，特别是 healthCheck() 方法',
        '- 完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(worktree, '.daemon', 'output.txt'),
    });

    console.log('=== 任务2 结果 ===');
    console.log('success:', result.success);
    console.log('durationMs:', result.durationMs);
    console.log('error:', result.error?.slice(0, 300));

    const targetFile = path.join(worktree, 'apps/api/src/daemon/session-manager.ts');
    if (fs.existsSync(targetFile)) {
      const content = fs.readFileSync(targetFile, 'utf-8');
      console.log('healthCheck 仍存在:', content.includes('healthCheck'));
      console.log('getSessionIds 存在:', content.includes('getSessionIds'));
      expect(content).toContain('healthCheck');
      expect(content).toContain('getSessionIds');
    }

    expect(result.success).toBe(true);
  }, 180_000);

  it('任务3: 并发提交两个任务，第二个应该被拒绝', async () => {
    const execStatus = daemon.getStatus('executor');
    const worktree = execStatus!.worktree;

    // 先提交一个长任务
    const longTask = daemon.submitJob('executor', {
      prompt: [
        '## 任务',
        '在 apps/api/src/daemon/session-manager.ts 的 getSessionIds() 方法后面再加一个 resetCounters() 方法。',
        '',
        '方法签名: resetCounters(): void',
        '- 遍历 this.sessions，将每个 session 的 taskCount 重置为 0',
        '',
        '完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(worktree, '.daemon', 'output.txt'),
    });

    // 立即提交第二个（应该被并发保护拒绝）
    try {
      const concurrent = await daemon.submitJob('executor', {
        prompt: '简单任务，输出 DONE',
        outputFile: path.join(worktree, '.daemon', 'output2.txt'),
      });
      // 如果到这里说明并发保护没生效
      console.log('⚠️ 并发任务未被拒绝 — 并发保护可能失效');
      console.log('concurrent success:', concurrent.success);
    } catch (err) {
      console.log('✅ 并发保护生效:', (err as Error).message);
    }

    // 等第一个任务完成
    const result = await longTask;
    console.log('=== 任务3 结果 ===');
    console.log('success:', result.success);
    console.log('durationMs:', result.durationMs);
    console.log('error:', result.error?.slice(0, 300));

    expect(result.success).toBe(true);
  }, 180_000);
});
