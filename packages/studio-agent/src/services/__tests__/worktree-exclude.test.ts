/**
 * Behavioral tests for worktree 工具产物 exclude（§10.5 提交守卫误伤修复；#154 删 .studio/）
 *
 * AC:
 *   - 新建 worktree（ensureWuWorktree / createWorktree）→ 仓库级 .git/info/exclude 写入
 *     `.claude/`、`.daemon/`、`.agent.log` 等行，git status 不再看到这些产物
 *   - `.studio/` 不再排除（#154/T5：业务仓 .studio/ = 纯文档正本整体进 git），
 *     存量 exclude 里的 `.studio/` 行被自愈清除
 *   - 不排除 AGENTS.md（内容文件，agent 可能 legit 修改）
 *   - 已有 worktree 复用 → 不重复写（幂等）
 *   - 主 workspace 路径（resolveWorkspace P1 直给 workspaceRoot）→ 完全不动 exclude
 *
 * Strategy: 真实 git 仓库 + 真实 execSh —— exclude 是否被 git status 采纳只能真实验证
 * （git 2.43 实测 exclude 为仓库级共享，无 per-worktree exclude）。
 */

import { describe, test, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { ensureWuWorktree, createWorktree, resolveWorkspace } from '../worktree-resolver.js';
import type { AgentTask } from '../types.js';

const TEST_TIMEOUT = 30_000;
const PATTERNS = ['.claude/', '.daemon/', '.agent.log', '.harness/'];

const tmpRoots: string[] = [];

afterEach(async () => {
  // worktree 里有产物时 remove 需 --force；直接整体删（repo gitdir 一并删，无残留引用）
  await Promise.all(tmpRoots.splice(0).map(d => fsp.rm(d, { recursive: true, force: true })));
});

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

async function makeRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wt-exclude-repo-'));
  tmpRoots.push(dir);
  git('init -q -b master', dir);
  git('config user.email test@test', dir);
  git('config user.name test', dir);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  git('add f.txt', dir);
  git('commit -qm init', dir);
  return dir;
}

function readExclude(repoDir: string): string {
  const p = path.join(repoDir, '.git', 'info', 'exclude');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

function writeToolArtifacts(worktree: string): void {
  fs.mkdirSync(path.join(worktree, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.claude', 'settings.json'), '{}');
  fs.mkdirSync(path.join(worktree, '.daemon'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.daemon', 'prompt.md'), 'x');
  fs.writeFileSync(path.join(worktree, '.agent.log'), 'x');
}

describe('worktree 工具产物 exclude', () => {
  test('ensureWuWorktree 新建 → exclude 写入工具产物行（不含 .studio/），git status 看不到工具产物，AGENTS.md 不排除', async () => {
    const repoDir = await makeRepo();
    const worktreesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wt-exclude-wts-'));
    tmpRoots.push(worktreesDir);

    const info = await ensureWuWorktree({ wuId: 'wu-1', repoDir, worktreesDir, baseBranch: 'master' });

    const exclude = readExclude(repoDir);
    for (const p of PATTERNS) expect(exclude).toContain(p);
    expect(exclude).not.toContain('.studio/');
    expect(exclude).not.toContain('AGENTS.md');

    writeToolArtifacts(info.worktreePath);
    expect(git('status --porcelain', info.worktreePath)).toBe('');

    // #154：.studio/ 是纯文档正本 —— 不被 exclude，照常出现在 status（可入库）
    fs.mkdirSync(path.join(info.worktreePath, '.studio'), { recursive: true });
    fs.writeFileSync(path.join(info.worktreePath, '.studio', 'CONTEXT.md'), '# ctx\n');
    expect(git('status --porcelain', info.worktreePath)).toBe('?? .studio/');

    // AGENTS.md 是内容文件 —— 不被 exclude，照常出现在 status
    fs.rmSync(path.join(info.worktreePath, '.studio'), { recursive: true, force: true });
    fs.writeFileSync(path.join(info.worktreePath, 'AGENTS.md'), '# guide\n');
    expect(git('status --porcelain', info.worktreePath)).toBe('?? AGENTS.md');
  }, TEST_TIMEOUT);

  test('存量 exclude 含 .studio/ 行 → 新建 worktree 时自愈清除', async () => {
    const repoDir = await makeRepo();
    const worktreesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wt-exclude-wts-'));
    tmpRoots.push(worktreesDir);
    // 模拟 #154 前的存量 exclude
    fs.mkdirSync(path.join(repoDir, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.git', 'info', 'exclude'), '.claude/\n.studio/\n.daemon/\n', 'utf-8');

    await ensureWuWorktree({ wuId: 'wu-1', repoDir, worktreesDir, baseBranch: 'master' });

    const exclude = readExclude(repoDir);
    expect(exclude.split('\n').filter(l => l.trim() === '.studio/')).toHaveLength(0);
    for (const p of PATTERNS) expect(exclude).toContain(p);
  }, TEST_TIMEOUT);

  test('已有 worktree 复用 → 不重复写 exclude（幂等，每行仍只出现一次）', async () => {
    const repoDir = await makeRepo();
    const worktreesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wt-exclude-wts-'));
    tmpRoots.push(worktreesDir);

    await ensureWuWorktree({ wuId: 'wu-1', repoDir, worktreesDir, baseBranch: 'master' });
    // 复用路径（目录含 .git 直接返回，不经过 createWorktree）
    await ensureWuWorktree({ wuId: 'wu-1', repoDir, worktreesDir, baseBranch: 'master' });

    const exclude = readExclude(repoDir);
    for (const p of PATTERNS) {
      expect(exclude.split('\n').filter(l => l.trim() === p)).toHaveLength(1);
    }
  }, TEST_TIMEOUT);

  test('createWorktree 直接调用 → 同样写 exclude；重复创建不堆行', async () => {
    const repoDir = await makeRepo();
    const worktree = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'wt-exclude-wt-')), 'w1');
    tmpRoots.push(path.dirname(worktree));

    await createWorktree(worktree, 'master', repoDir);
    expect(readExclude(repoDir)).toContain('.claude/');

    // createWorktree 会先清后建 —— exclude 仍幂等
    await createWorktree(worktree, 'master', repoDir);
    const exclude = readExclude(repoDir);
    for (const p of PATTERNS) {
      expect(exclude.split('\n').filter(l => l.trim() === p)).toHaveLength(1);
    }
  }, TEST_TIMEOUT);

  test('主 workspace 路径（workspaceRoot 直给，非 worktree）→ 不写 exclude', async () => {
    const repoDir = await makeRepo();
    const worktreesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wt-exclude-wts-'));
    tmpRoots.push(worktreesDir);
    const before = readExclude(repoDir);

    const task = { id: 't1', executionId: 'e1', parameters: { workspaceRoot: repoDir } } as unknown as AgentTask;
    const resolved = await resolveWorkspace({ task, worktreesDir, repoDir });

    expect(resolved).toBe(repoDir);
    expect(readExclude(repoDir)).toBe(before);
    for (const p of PATTERNS) expect(before).not.toContain(p);
  }, TEST_TIMEOUT);
});
