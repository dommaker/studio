/**
 * C1: OpsService.cleanupWorktrees 目录口径测试
 *
 * 回归：此前默认扫描 ~/.studio/worktrees，而 agent-loop.resolveWorktreesDir
 * 实际创建在 WORKTREES_DIR > ~/worktrees —— GC 在扫空目录。
 * 修复后默认口径与创建侧一致。
 *
 * 接线：POSIX 下 os.homedir() 取 $HOME，测试把 HOME 指向临时目录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OpsService } from '../ops/ops.service.js';

let tmpHome: string;
let savedHome: string | undefined;
let savedWorktreesDir: string | undefined;

beforeAll(() => {
  savedHome = process.env.HOME;
  savedWorktreesDir = process.env.WORKTREES_DIR;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-gc-home-'));
  process.env.HOME = tmpHome;
  delete process.env.WORKTREES_DIR;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedWorktreesDir === undefined) delete process.env.WORKTREES_DIR;
  else process.env.WORKTREES_DIR = savedWorktreesDir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('OpsService.cleanupWorktrees 目录口径（C1）', () => {
  it('默认扫描 ~/worktrees（实际创建位置），清理超龄目录、保留新目录', async () => {
    const worktreesDir = path.join(tmpHome, 'worktrees');
    const oldWt = path.join(worktreesDir, 'wu-old');
    const freshWt = path.join(worktreesDir, 'wu-fresh');
    fs.mkdirSync(oldWt, { recursive: true });
    fs.mkdirSync(freshWt, { recursive: true });
    // 8 天前 mtime（超过 7 天阈值）
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldWt, old, old);

    const cleaned = await new OpsService(0).cleanupWorktrees(7);

    expect(cleaned).toBe(1);
    expect(fs.existsSync(oldWt)).toBe(false);
    expect(fs.existsSync(freshWt)).toBe(true);
  });

  it('不再扫描 ~/.studio/worktrees（旧错误口径）', async () => {
    const legacyDir = path.join(tmpHome, '.studio', 'worktrees');
    const stale = path.join(legacyDir, 'wu-stale');
    fs.mkdirSync(stale, { recursive: true });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    const cleaned = await new OpsService(0).cleanupWorktrees(7);

    expect(cleaned).toBe(0);
    expect(fs.existsSync(stale)).toBe(true);
  });

  it('WORKTREES_DIR 环境变量优先于默认目录', async () => {
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-gc-env-'));
    const stale = path.join(envDir, 'wu-env');
    fs.mkdirSync(stale, { recursive: true });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    process.env.WORKTREES_DIR = envDir;
    try {
      const cleaned = await new OpsService(0).cleanupWorktrees(7);
      expect(cleaned).toBe(1);
      expect(fs.existsSync(stale)).toBe(false);
    } finally {
      delete process.env.WORKTREES_DIR;
      fs.rmSync(envDir, { recursive: true, force: true });
    }
  });
});
