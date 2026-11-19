/** #701：PMO 集成交合的多仓/多腿真实 Git 隔离与稳定复用。 */
import { afterEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensurePmoIntegrationWorktree } from '../worktree-resolver.js';

const tmpRoots: string[] = [];

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

async function makeRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wt-pmo-repo-'));
  tmpRoots.push(dir);
  git(['init', '-q', '-b', 'master'], dir);
  git(['config', 'user.email', 'test@example.invalid'], dir);
  git(['config', 'user.name', 'test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'test\n');
  git(['add', 'README.md'], dir);
  git(['commit', '-qm', 'init'], dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

describe('ensurePmoIntegrationWorktree 真实多仓/多腿', () => {
  test('同 project 的仓库与腿各自隔离，同身份稳定复用', async () => {
    const repoA = await makeRepo();
    const repoB = await makeRepo();
    const worktreesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wt-pmo-integration-'));
    tmpRoots.push(worktreesDir);
    const base = { worktreesDir, projectId: 'proj-multi', baseBranch: 'master' };

    const a = await ensurePmoIntegrationWorktree({ ...base, repoDir: repoA, branch: 'PMO-11-a' });
    const b = await ensurePmoIntegrationWorktree({ ...base, repoDir: repoB, branch: 'PMO-11-b' });
    const otherLeg = await ensurePmoIntegrationWorktree({ ...base, repoDir: repoA, branch: 'PMO-11-other' });

    expect(new Set([a.worktreePath, b.worktreePath, otherLeg.worktreePath]).size).toBe(3);
    expect(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], a.worktreePath))
      .toBe(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoA));
    expect(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], b.worktreePath))
      .toBe(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoB));
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], a.worktreePath)).toBe('PMO-11-a');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], b.worktreePath)).toBe('PMO-11-b');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], otherLeg.worktreePath)).toBe('PMO-11-other');

    const reused = await ensurePmoIntegrationWorktree({ ...base, repoDir: repoA, branch: 'PMO-11-a' });
    expect(reused.worktreePath).toBe(a.worktreePath);
  }, 30_000);
});
