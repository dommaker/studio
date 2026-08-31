/**
 * worktree GC 目录口径测试（#409 双实现归一）
 *
 * 原为 OpsService.cleanupWorktrees 目录口径测试（C1）：
 *   回归——此前默认扫描 ~/.studio/worktrees，而 agent-loop.resolveWorktreesDir
 *   实际创建在 WORKTREES_DIR > ~/worktrees —— GC 在扫空目录。
 * #409 后 GC 只剩 monitor-system-probes.gcStaleWorktrees 单实现（OpsService 版已删），
 * 目录口径断言迁移到统一实现：默认 ~/worktrees、WORKTREES_DIR 覆盖、按 mtime 过滤（7d 阈值）。
 *
 * 接线：POSIX 下 os.homedir() 取 $HOME；统一实现按调用时解析目录，
 * 测试把 HOME 指向临时目录、REPO_DIR 指向无 .git 的临时目录（跳过 git worktree prune）。
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { tmpHome, tmpRepo, savedHome, savedWorktreesDir, savedRepoDir } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gc-home-'));
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gc-repo-')); // 无 .git → 跳过 prune
  const savedHome = process.env.HOME;
  const savedWorktreesDir = process.env.WORKTREES_DIR;
  const savedRepoDir = process.env.REPO_DIR;
  process.env.HOME = tmpHome;
  process.env.REPO_DIR = tmpRepo;
  delete process.env.WORKTREES_DIR;
  return { tmpHome, tmpRepo, savedHome, savedWorktreesDir, savedRepoDir };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => cb(null, '')),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dommaker/harness', () => ({
  KnowledgeLinter: class {},
  KnowledgeHealthScorer: class {},
  ReferenceTracker: class {},
}));

vi.mock('../../knowledge/knowledge-singletons.js', () => ({
  sharedStore: {},
  sharedLifecycle: {},
}));

vi.mock('../../knowledge/knowledge-sync.service.js', () => ({
  knowledgeSync: {},
}));

vi.mock('../triage/triage.service.js', () => ({
  triageService: {},
}));

vi.mock('../monitor/monitor-alerts.js', () => ({
  emitMonitorEvent: vi.fn(),
}));

import { gcStaleWorktrees } from '../monitor/monitor-system-probes.js';

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedWorktreesDir === undefined) delete process.env.WORKTREES_DIR;
  else process.env.WORKTREES_DIR = savedWorktreesDir;
  if (savedRepoDir === undefined) delete process.env.REPO_DIR;
  else process.env.REPO_DIR = savedRepoDir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

function makeStaleDir(parent: string, name: string, ageDays: number): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  fs.utimesSync(dir, old, old);
  return dir;
}

describe('gcStaleWorktrees 目录口径（#409 统一实现）', () => {
  it('默认扫描 ~/worktrees（实际创建位置），清理超龄目录、保留新目录', async () => {
    const worktreesDir = path.join(tmpHome, 'worktrees');
    const oldWt = makeStaleDir(worktreesDir, 'wu-old', 8); // 8 天前 mtime（超过 7d 阈值）
    const freshWt = path.join(worktreesDir, 'wu-fresh');
    fs.mkdirSync(freshWt, { recursive: true });

    await gcStaleWorktrees();

    expect(fs.existsSync(oldWt)).toBe(false);
    expect(fs.existsSync(freshWt)).toBe(true);
  });

  it('不再扫描 ~/.studio/worktrees（旧错误口径）', async () => {
    const stale = makeStaleDir(path.join(tmpHome, '.studio', 'worktrees'), 'wu-stale', 30);

    await gcStaleWorktrees();

    expect(fs.existsSync(stale)).toBe(true);
  });

  it('WORKTREES_DIR 环境变量优先于默认目录', async () => {
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gc-env-'));
    const stale = makeStaleDir(envDir, 'wu-env', 30);
    process.env.WORKTREES_DIR = envDir;
    try {
      await gcStaleWorktrees();
      expect(fs.existsSync(stale)).toBe(false);
    } finally {
      delete process.env.WORKTREES_DIR;
      fs.rmSync(envDir, { recursive: true, force: true });
    }
  });
});
