// B4a（决策 D8）: daemon.start() 不再创建 reviewer session / worktree
//
// 验收：start() 后 git worktree list 不新增 worktree、git branch 不出现 daemon/reviewer-*。
// 在 scratch git 仓库（tmpdir）里跑，绝不碰真实仓库。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: vi.fn().mockResolvedValue({ stdout: 'claude 1.0.0' }),
  buildHealthProbeCommand: vi.fn(() => 'claude --version'),
  resolveSessionId: vi.fn(() => null),
  readSessionIdFile: vi.fn(() => null),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => ({
  // Spread real module: FileStore & other exports must exist
  ...(await importOriginal<typeof import('@dommaker/studio-shared')>()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { executeLightweight: vi.fn(), stop: vi.fn(), execute: vi.fn() },
}));

vi.mock('../task-logger.js', () => ({
  writeTaskLog: vi.fn(),
  classifyTaskError: vi.fn(() => 'unknown'),
}));

describe('B4a: daemon.start() 不再创建 reviewer worktree', () => {
  let scratchRepo: string;
  let worktreesDir: string;
  let daemon: typeof import('../studio-daemon.js').daemon;

  beforeAll(async () => {
    // scratch git 仓库当 REPO_DIR — studio-daemon 的 REPO_DIR/WORKTREES_DIR
    // 在模块 import 时定型，必须先设 env 再动态 import
    scratchRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-start-repo-'));
    worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-start-wt-'));
    execSync('git init -q && git commit -q --allow-empty -m init', { cwd: scratchRepo });
    process.env.REPO_DIR = scratchRepo;
    process.env.WORKTREES_DIR = worktreesDir;
    ({ daemon } = await import('../studio-daemon.js'));
    daemon.start();
  });

  afterAll(() => {
    daemon.stop();
    fs.rmSync(scratchRepo, { recursive: true, force: true });
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  });

  it('start() 只注册 analyst，不注册 reviewer session', () => {
    const names = daemon.getStatus().filter(Boolean).map(s => s!.name);
    expect(names).toContain('analyst');
    expect(names).not.toContain('reviewer');
  });

  it('start() 不新增 git worktree', () => {
    const out = execSync('git worktree list --porcelain', { cwd: scratchRepo }).toString();
    const entries = out.match(/^worktree /gm) ?? [];
    expect(entries).toHaveLength(1); // 只剩主 worktree
  });

  it('start() 不创建 daemon/reviewer-* 分支', () => {
    const branches = execSync('git branch --list "daemon/*"', { cwd: scratchRepo }).toString().trim();
    expect(branches).toBe('');
  });

  it('start() 不在 WORKTREES_DIR 下创建 reviewer-main', () => {
    expect(fs.existsSync(path.join(worktreesDir, 'reviewer-main'))).toBe(false);
  });

  it('重复 start() 幂等（不重复注册）', () => {
    daemon.start();
    const names = daemon.getStatus().filter(Boolean).map(s => s!.name);
    expect(names.filter(n => n === 'analyst')).toHaveLength(1);
  });
});
