import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateExecutionRepo, withExecutionRepo } from '../execution-repo-policy.js';

const execFileAsync = promisify(execFile);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-repo-policy-'));
const repoDir = path.join(tmpRoot, 'repo');
fs.mkdirSync(repoDir);
const originalRoots = process.env.PMO_GIT_REPO_ROOTS;

beforeEach(() => {
  process.env.PMO_GIT_REPO_ROOTS = tmpRoot;
});

afterAll(() => {
  if (originalRoots === undefined) delete process.env.PMO_GIT_REPO_ROOTS;
  else process.env.PMO_GIT_REPO_ROOTS = originalRoots;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('validateExecutionRepo', () => {
  it('PMO 与 channel.defaultPath 共用允许根和目录约束', () => {
    expect(validateExecutionRepo(repoDir)).toBeNull();
    expect(validateExecutionRepo('/etc')).toContain('existing directory under an allowed root');
    expect(validateExecutionRepo(path.join(tmpRoot, 'missing'))).not.toBeNull();
  });

  it('拒绝 repo 根及真实父目录 symlink，且不触碰越界目录', () => {
    const outside = path.join(tmpRoot, 'outside');
    const nestedOutside = path.join(outside, 'nested');
    fs.mkdirSync(nestedOutside, { recursive: true });
    const marker = path.join(nestedOutside, 'marker');
    fs.writeFileSync(marker, 'unchanged');
    const rootLink = path.join(tmpRoot, 'root-link');
    const parentLink = path.join(tmpRoot, 'parent-link');
    fs.symlinkSync(nestedOutside, rootLink);
    fs.symlinkSync(outside, parentLink);

    expect(validateExecutionRepo(rootLink)).not.toBeNull();
    expect(validateExecutionRepo(path.join(parentLink, 'nested'))).not.toBeNull();
    expect(fs.readFileSync(marker, 'utf8')).toBe('unchanged');
  });

  it('检查与使用间 repo 根被替换为 symlink 时 fail-closed', () => {
    const outside = path.join(tmpRoot, 'race-outside');
    fs.mkdirSync(outside);
    const marker = path.join(outside, 'marker');
    fs.writeFileSync(marker, 'unchanged');
    const replaceWithSymlink = () => {
      if (fs.existsSync(`${repoDir}-original`)) return;
      fs.renameSync(repoDir, `${repoDir}-original`);
      fs.symlinkSync(outside, repoDir);
    };
    const realpath = fs.realpathSync.bind(fs);
    const stat = fs.statSync.bind(fs);
    vi.spyOn(fs, 'realpathSync').mockImplementation(targetPath => {
      replaceWithSymlink();
      return realpath(targetPath as fs.PathLike);
    });
    vi.spyOn(fs, 'statSync').mockImplementation(((targetPath: fs.PathLike) => {
      replaceWithSymlink();
      return stat(targetPath);
    }) as typeof fs.statSync);
    try {
      expect(validateExecutionRepo(repoDir)).not.toBeNull();
      expect(fs.readFileSync(marker, 'utf8')).toBe('unchanged');
    } finally {
      vi.restoreAllMocks();
      if (fs.existsSync(`${repoDir}-original`)) {
        fs.rmSync(repoDir, { recursive: true, force: true });
        fs.renameSync(`${repoDir}-original`, repoDir);
      }
    }
  });

  it('真实 Git 子进程在 repo 替换后仍操作固定目录，合法 Git 成功', async () => {
    const repo = path.join(tmpRoot, 'real-git');
    const original = path.join(tmpRoot, 'real-git-original');
    const outside = path.join(tmpRoot, 'real-git-outside');
    fs.mkdirSync(outside);
    await execFileAsync('git', ['init', repo]);

    await withExecutionRepo(repo, async capabilityPath => {
      await execFileAsync('git', ['-C', capabilityPath, 'status', '--porcelain']);
      expect(capabilityPath).toMatch(new RegExp(`^/proc/${process.pid}/fd/\\d+$`));

      fs.renameSync(repo, original);
      fs.symlinkSync(outside, repo);
      fs.writeFileSync(path.join(capabilityPath, 'safe.txt'), 'safe');
      await execFileAsync('git', ['-C', capabilityPath, 'add', '--', 'safe.txt']);
      const { stdout } = await execFileAsync('git', ['-C', capabilityPath, 'diff', '--cached', '--name-only']);
      expect(stdout.trim()).toBe('safe.txt');
    });

    expect(fs.existsSync(path.join(outside, 'safe.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(original, 'safe.txt'), 'utf8')).toBe('safe');
    expect((await execFileAsync('git', ['-C', original, 'diff', '--cached', '--name-only'])).stdout.trim()).toBe('safe.txt');
  });
});
