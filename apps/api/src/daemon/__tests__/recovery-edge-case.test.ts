// 深挖：过期恢复边界情况测试
import { describe, it, expect, vi } from 'vitest';

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: vi.fn().mockResolvedValue({
    stdout: '{"result": "DONE", "usage": {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 0}}',
  }),
  resolveSessionId: vi.fn(() => null),
  readSessionIdFile: vi.fn(() => null),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => ({
  // Spread real module: FileStore & other post-migration exports must exist
  // (session-summary-generator constructs `new FileStore()` at import time).
  ...(await importOriginal<typeof import('@dommaker/studio-shared')>()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  parseStreamEvents: vi.fn(() => []),
  extractUsage: vi.fn(() => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })),
  extractResult: vi.fn(() => ({ text: 'DONE', isError: false })),
  extractToolCalls: vi.fn(() => []),
  extractWriteContent: vi.fn(() => null),
  buildSpawnEnv: vi.fn(() => ({})),
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  beforeAgentExecute: vi.fn(),
  buildAgentConstraintPrompt: vi.fn(() => ''),
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

vi.mock('../metrics.js', () => ({
  parseClaudeUsage: vi.fn(() => ({ inputTokens: 100, outputTokens: 50, cacheHitTokens: 0 })),
  recordExecution: vi.fn(() => Promise.resolve()),
  recordAgentSessionFromLog: vi.fn(),
}));

vi.mock('../task-logger.js', () => ({
  writeTaskLog: vi.fn(),
  classifyTaskError: vi.fn(() => 'unknown'),
}));

import { SessionManager } from '../session-manager.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const WORKTREES_DIR = path.join(os.tmpdir(), 'daemon-recovery-edge-test');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

describe('Session 过期恢复边界情况', () => {
  it('BUG: daemon 重启 + Claude session 已删除 → 第一任务应触发恢复但实际跳过', async () => {
    const wt = path.join(WORKTREES_DIR, 'edge-case-1');
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'data.ts'), 'export const data = 0;\n', 'utf-8');

    // Step 1: 正常创建 session 并跑一个任务
    const mgr1 = new SessionManager();
    mgr1.register({ name: 'test', worktree: wt, timeoutMs: 60_000, persistent: true });
    const r1 = await mgr1.runTask('test', {
      prompt: '在 src/data.ts 中把 data 改为 1。完成后输出 "DONE"',
      outputFile: path.join(wt, '.daemon', 'out1.txt'),
    });
    console.log('Step 1 (创建 session):', r1.success, `${r1.durationMs}ms`);
    expect(r1.success).toBe(true);

    // 拿到 worktree 的 session-id，找到对应的 Claude session 文件
    const sidFile = path.join(wt, '.daemon', 'session-id');
    const worktreeSid = fs.readFileSync(sidFile, 'utf-8').trim();
    console.log('Worktree session-id:', worktreeSid);

    // SessionManager 注册时，目录路径被 hash 成 Claude projects 目录名
    // Claude 的 projects 目录命名规则: 路径的 / 替换为 -，特殊字符编码
    const wtHash = wt.replace(/\//g, '-');
    const claudeProjectDir = path.join(CLAUDE_PROJECTS, wtHash);
    console.log('Claude project dir:', claudeProjectDir);
    console.log('exists:', fs.existsSync(claudeProjectDir));

    if (fs.existsSync(claudeProjectDir)) {
      const files = fs.readdirSync(claudeProjectDir);
      console.log('Session files:', files);
    }

    // Step 2: 模拟 Claude session 过期 — 删除 Claude 的 session 文件
    if (fs.existsSync(claudeProjectDir)) {
      const sessionFiles = fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'));
      for (const f of sessionFiles) {
        fs.unlinkSync(path.join(claudeProjectDir, f));
        console.log('Deleted:', f);
      }
    }

    // Step 3: 重新注册（模拟 daemon 重启）
    const mgr2 = new SessionManager();
    mgr2.register({ name: 'test', worktree: wt, timeoutMs: 60_000, persistent: true });
    const status = mgr2.getStatus('test');
    console.log('重启后 session-id:', status?.sessionId || 'unknown');

    // Step 4: 跑第一个任务 — 因为 isNewSession=false，会用 --continue
    // --continue 找不到 session → 应该触发恢复，但当前代码有 bug
    const r2 = await mgr2.runTask('test', {
      prompt: '在 src/data.ts 中把 data 改为 2。完成后输出 "DONE"',
      outputFile: path.join(wt, '.daemon', 'out2.txt'),
    });

    console.log('\n=== Step 4 结果 ===');
    console.log('success:', r2.success);
    console.log('error:', r2.error?.slice(0, 300));
    console.log('durationMs:', r2.durationMs);

    if (r2.success) {
      const dataFile = path.join(wt, 'src', 'data.ts');
      console.log('data.ts:', fs.readFileSync(dataFile, 'utf-8').trim());
    }

    // 当前行为（有 bug）：--continue 失败 → isFirstTask=true → 跳过恢复 → 返回失败
    // 预期行为：--continue 失败 → 检测到 session 过期 → 自动用新 session-id 重试 → 成功
    if (!r2.success && r2.error?.includes('no previous session')) {
      console.log('\n✅ BUG 确认: 过期恢复在 isFirstTask=true 时被跳过');
      console.log('   修复方向: 条件改为 (isSessionExpired && (!isFirstTask || !state.isNewSession))');
    } else if (r2.success) {
      console.log('\n⚠️ --continue 可能仍然找到了 session（Claude 内部可能有缓存）');
    }
  }, 180_000);
});
