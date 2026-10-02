/**
 * worktree GC 目录口径测试（#409 双实现归一；P2-e 契约 §8 双口径收编）
 *
 * 原为 OpsService.cleanupWorktrees 目录口径测试（C1）：
 *   回归——此前默认扫描 ~/.studio/worktrees，而 agent-loop.resolveWorktreesDir
 *   实际创建在 WORKTREES_DIR > ~/worktrees —— GC 在扫空目录。
 * #409 后 GC 只剩 monitor-system-probes.gcStaleWorktrees 单实现（OpsService 版已删）。
 * P2-e（数据目录契约 §8「待归位」冻结结论）：fallback 自 ~/worktrees 改走
 * studioPath('worktrees')——创建侧 bootstrap/config.ts 注入 WORKTREES_DIR=<studioDir>/worktrees，
 * fallback 与注入值同源，双口径消除。
 *
 * 接线：统一实现按调用时解析目录；测试把 STUDIO_HOME 指向临时目录、
 * REPO_DIR 指向无 .git 的临时目录（跳过 git worktree prune）。
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { tmpStudio, tmpRepo, savedStudioHome, savedWorktreesDir, savedRepoDir } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const tmpStudio = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gc-studio-'));
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gc-repo-')); // 无 .git → 跳过 prune
  const savedStudioHome = process.env.STUDIO_HOME;
  const savedWorktreesDir = process.env.WORKTREES_DIR;
  const savedRepoDir = process.env.REPO_DIR;
  process.env.STUDIO_HOME = tmpStudio;
  process.env.REPO_DIR = tmpRepo;
  delete process.env.WORKTREES_DIR;
  return { tmpStudio, tmpRepo, savedStudioHome, savedWorktreesDir, savedRepoDir };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => cb(null, '')),
}));

vi.mock('@dommaker/studio-shared', () => ({ stripTrailingSlashes: (s) => s, createSettledTracker: () => ({ track: () => {}, waitForSettled: async () => {} }), FileStore: class {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dommaker/harness', () => ({
  KnowledgeLinter: class {},
  KnowledgeHealthScorer: class {},
  ReferenceTracker: class {},
}));

vi.mock('../../knowledge/knowledge-singletons.js', () => ({ sharedLinter: vi.fn(), sharedIngest: vi.fn(),
  sharedStore: {},
  sharedLifecycle: {},
}));

vi.mock('../../knowledge/knowledge-sync.service.js', () => ({
  knowledgeSync: {},
}));

vi.mock('../../triage/index.js', () => ({
  triageService: {},
}));

vi.mock('../../agent-monitor/monitor-alerts.js', () => ({
  emitMonitorEvent: vi.fn(),
}));

import { gcStaleWorktrees } from '../../agent-monitor/monitor-system-probes.js';

afterAll(() => {
  if (savedStudioHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = savedStudioHome;
  if (savedWorktreesDir === undefined) delete process.env.WORKTREES_DIR;
  else process.env.WORKTREES_DIR = savedWorktreesDir;
  if (savedRepoDir === undefined) delete process.env.REPO_DIR;
  else process.env.REPO_DIR = savedRepoDir;
  fs.rmSync(tmpStudio, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

function makeStaleDir(parent: string, name: string, ageDays: number): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  fs.utimesSync(dir, old, old);
  return dir;
}

describe('gcStaleWorktrees 目录口径（#409 统一实现；P2-e 契约 §8 fallback 收编）', () => {
  it('默认扫描 studioPath(\'worktrees\')（与创建侧注入值同源），清理超龄目录、保留新目录', async () => {
    const worktreesDir = path.join(tmpStudio, 'worktrees');
    const oldWt = makeStaleDir(worktreesDir, 'wu-old', 8); // 8 天前 mtime（超过 7d 阈值）
    const freshWt = path.join(worktreesDir, 'wu-fresh');
    fs.mkdirSync(freshWt, { recursive: true });

    await gcStaleWorktrees();

    expect(fs.existsSync(oldWt)).toBe(false);
    expect(fs.existsSync(freshWt)).toBe(true);
  });

  it('不再扫描 ~/worktrees（P2-e 前旧口径）', async () => {
    // HOME 指向临时目录，避免触碰真实 ~/worktrees；STUDIO_HOME 仍钉 tmpStudio
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gc-home-'));
    const savedHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const stale = makeStaleDir(path.join(tmpHome, 'worktrees'), 'wu-stale', 30);
      await gcStaleWorktrees();
      expect(fs.existsSync(stale)).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
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
