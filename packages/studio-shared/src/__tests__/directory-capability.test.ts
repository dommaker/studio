import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDirectoryCapability } from '../directory-capability';

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-capability-'));
  outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('withDirectoryCapability（SEC-04）', () => {
  it('回调期间原路径被替换为 symlink 仍只使用固定目录，返回后关闭 capability', async () => {
    const repo = path.join(root, 'repo');
    const original = path.join(root, 'repo-original');
    fs.mkdirSync(repo);
    const result = await withDirectoryCapability(repo, async capabilityPath => {
      expect(capabilityPath).toMatch(new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
      fs.renameSync(repo, original);
      fs.symlinkSync(outside, repo);
      fs.writeFileSync(path.join(capabilityPath, 'safe.txt'), 'safe');
      return capabilityPath;
    });

    expect(fs.existsSync(path.join(outside, 'safe.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(original, 'safe.txt'), 'utf8')).toBe('safe');
    expect(fs.existsSync(result)).toBe(false);
  });

  it('初始 repo 根 symlink 直接拒绝，不读取或写入越界目标', async () => {
    const repo = path.join(root, 'repo-link');
    fs.symlinkSync(outside, repo);
    await expect(withDirectoryCapability(repo, async () => 'must-not-run')).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
