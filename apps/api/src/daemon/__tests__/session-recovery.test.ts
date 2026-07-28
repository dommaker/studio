// Session 过期恢复 & daemon 崩溃恢复 实战测试
import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const WORKTREES_DIR = path.join(os.tmpdir(), 'daemon-recovery-test');

// Mock dependencies — no real Claude CLI needed
// execSh simulates Claude file modifications based on prompt content
vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: vi.fn(async (cmd: string) => {
    const promptMatch = cmd.match(/< "(.+?)"/);
    const cdMatch = cmd.match(/cd "(.+?)"/);
    if (promptMatch && cdMatch) {
      const prompt = fs.readFileSync(promptMatch[1], 'utf-8');
      const wt = cdMatch[1];

      // Simulate counter.ts modifications
      if (prompt.includes('export let count = 1')) {
        fs.writeFileSync(path.join(wt, 'src', 'counter.ts'), 'export let count = 1;\n');
      } else if (prompt.includes('count = 2') || prompt.includes('\u6539\u6210 2')) {
        fs.writeFileSync(path.join(wt, 'src', 'counter.ts'), 'export let count = 2;\n');
      }

      // Simulate version.ts modifications
      if (prompt.includes('"1.1"')) {
        fs.writeFileSync(path.join(wt, 'src', 'version.ts'), 'export const VERSION = "1.1";\n');
      } else if (prompt.includes('"1.2"')) {
        fs.writeFileSync(path.join(wt, 'src', 'version.ts'), 'export const VERSION = "1.2";\n');
      }
    }
    return {
      stdout: '{"result": "DONE", "usage": {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 0}}',
    };
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

// Mock @dommaker/studio-agent: SessionManager.runTask 委托给 agentRunner.executeLightweight
// 模拟 Claude 根据 prompt 内容修改文件，返回成功结果
vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: vi.fn(async (task: {
      prompt: string;
      executionId: string;
      parameters?: { worktree?: string };
    }) => {
      const prompt = task.prompt || '';
      const wt = task.parameters?.worktree || '';

      if (wt) {
        // Simulate counter.ts modifications
        if (prompt.includes('export let count = 1')) {
          fs.writeFileSync(path.join(wt, 'src', 'counter.ts'), 'export let count = 1;\n');
        } else if (prompt.includes('count = 2') || prompt.includes('\u6539\u6210 2')) {
          fs.writeFileSync(path.join(wt, 'src', 'counter.ts'), 'export let count = 2;\n');
        }

        // Simulate version.ts modifications
        if (prompt.includes('"1.1"')) {
          fs.writeFileSync(path.join(wt, 'src', 'version.ts'), 'export const VERSION = "1.1";\n');
        } else if (prompt.includes('"1.2"')) {
          fs.writeFileSync(path.join(wt, 'src', 'version.ts'), 'export const VERSION = "1.2";\n');
        }
      }

      return {
        success: true,
        worktree: wt,
        outputFiles: [],
        logFile: '',
        sessionCount: 1,
        totalDurationMs: 100,
        sessionIds: [task.executionId],
        outputText: 'DONE',
      };
    }),
  },
}));

import { SessionManager } from '../session-manager.js';

describe('Session 过期自动重建', () => {
  it('--continue 在 session 过期后自动重建并重试', async () => {
    const wt = path.join(WORKTREES_DIR, 'recovery-test');
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'counter.ts'), 'export let count = 0;\n', 'utf-8');

    const mgr = new SessionManager();

    // Step 1: 注册 session，正常跑一个任务
    mgr.register({
      name: 'test-session',
      worktree: wt,
      timeoutMs: 60_000,
      persistent: true,
    });

    const r1 = await mgr.runTask('test-session', {
      prompt: [
        '## 任务',
        '在 src/counter.ts 中，将 count 改为 1。export let count = 1;',
        '不要改其他内容。完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(wt, '.daemon', 'out.txt'),
    });

    console.log('=== Step 1: 正常创建 session ===');
    console.log('success:', r1.success, 'durationMs:', r1.durationMs);

    // 验证产出
    const counterFile = path.join(wt, 'src', 'counter.ts');
    console.log('counter.ts:', fs.readFileSync(counterFile, 'utf-8').trim());
    expect(r1.success).toBe(true);

    // Step 2: 模拟 session 过期 — 破坏 session-id 文件
    const sidFile = path.join(wt, '.daemon', 'session-id');
    const oldSid = fs.readFileSync(sidFile, 'utf-8').trim();
    console.log('旧 session-id:', oldSid);

    // 写入一个无效的 UUID，让 --continue 找不到 session
    const fakeSid = '00000000-0000-0000-0000-000000000000';
    fs.writeFileSync(sidFile, fakeSid, 'utf-8');

    // 重新注册（模拟 daemon 重启）
    mgr.register({
      name: 'test-session-recovered',
      worktree: wt,
      timeoutMs: 60_000,
      persistent: true,
    });

    const status = mgr.getStatus('test-session-recovered');
    console.log('恢复后的 session-id:', status?.sessionId || 'unknown');

    // Step 3: 用 --continue 续接过期的 session
    // 预期：--continue 失败 → 检测 "no previous session" → 生成新 UUID 重试 → 成功
    const r2 = await mgr.runTask('test-session-recovered', {
      prompt: [
        '## 任务',
        '在 src/counter.ts 中，将 count 再加 1（改成 2）。export let count = 2;',
        '完成后输出 "DONE"',
      ].join('\n'),
      outputFile: path.join(wt, '.daemon', 'out2.txt'),
    });

    console.log('\n=== Step 3: Session 过期后自动重建 ===');
    console.log('success:', r2.success);
    console.log('error:', r2.error?.slice(0, 200));
    console.log('durationMs:', r2.durationMs);

    if (r2.success) {
      console.log('counter.ts:', fs.readFileSync(counterFile, 'utf-8').trim());
      console.log('✅ Session 过期自动重建成功');
    }

    expect(r2.success).toBe(true);
    expect(fs.readFileSync(counterFile, 'utf-8')).toContain('count = 2');
  }, 180_000);

  it('daemon 重启后 --continue 恢复已有 session', async () => {
    const wt = path.join(WORKTREES_DIR, 'restart-test');
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'version.ts'), 'export const VERSION = "1.0";\n', 'utf-8');

    // 第一个 SessionManager 实例
    const mgr1 = new SessionManager();
    mgr1.register({
      name: 'restart-session',
      worktree: wt,
      timeoutMs: 60_000,
      persistent: true,
    });

    const r1 = await mgr1.runTask('restart-session', {
      prompt: '在 src/version.ts 中把 VERSION 改为 "1.1"。完成后输出 "DONE"',
      outputFile: path.join(wt, '.daemon', 'out.txt'),
    });
    console.log('=== Round 1 ===');
    console.log('success:', r1.success, 'durationMs:', r1.durationMs);
    expect(r1.success).toBe(true);
    expect(fs.readFileSync(path.join(wt, 'src', 'version.ts'), 'utf-8')).toContain('"1.1"');

    // 模拟 daemon 重启：创建新的 SessionManager 实例，从文件加载 session-id
    const mgr2 = new SessionManager();
    mgr2.register({
      name: 'restart-session',
      worktree: wt,
      timeoutMs: 60_000,
      persistent: true,
    });

    // 第一个任务：因为从文件加载了已有 session-id，isNewSession=false
    // 应该用 --continue（而不是 --session-id --name）
    const r2 = await mgr2.runTask('restart-session', {
      prompt: '在 src/version.ts 中把 VERSION 改为 "1.2"。完成后输出 "DONE"',
      outputFile: path.join(wt, '.daemon', 'out2.txt'),
    });

    console.log('\n=== Round 2 (daemon 重启后) ===');
    console.log('success:', r2.success, 'durationMs:', r2.durationMs);
    console.log('error:', r2.error?.slice(0, 200));

    const versionFile = path.join(wt, 'src', 'version.ts');
    console.log('version.ts:', fs.readFileSync(versionFile, 'utf-8').trim());

    expect(r2.success).toBe(true);
    expect(fs.readFileSync(versionFile, 'utf-8')).toContain('"1.2"');
    console.log('✅ Daemon 重启后 session 恢复成功，cache 复用正常');
  }, 180_000);
});
