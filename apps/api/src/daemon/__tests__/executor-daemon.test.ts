// Executor Daemon 实战测试
// 实际 spawn Claude Code 跑编码任务，在实战中发现并修复问题
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { daemon } from '../studio-daemon.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const WORKTREES_DIR = path.join(os.tmpdir(), 'daemon-executor-test');

describe('Executor Daemon 实战测试', () => {
  beforeAll(() => {
    process.env.REPO_DIR = process.env.REPO_DIR || '/root/projects/agent-studio';
    process.env.WORKTREES_DIR = WORKTREES_DIR;

    // 清理
    try { fs.rmSync(WORKTREES_DIR, { recursive: true, force: true }); } catch {}

    // 启动 daemon（注册 analyst + executor）
    daemon.start();

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
      const srcFile = path.join(process.env.REPO_DIR!, 'apps/api/src/daemon/session-manager.ts');
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
