/**
 * file-store-default 持有器单测：惰性兜底（env 解析根按根缓存）/ setDefault 钉定 /
 * env 变根新实例 / reset 恢复惰性。env 改动一律 afterEach 复原 + reset。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FileStore } from '../file-store';
import { getDefaultFileStore, setDefaultFileStore, resetDefaultFileStoreForTesting } from '../file-store-default';

const origDataDir = process.env.STUDIO_DATA_DIR;

function mkRoot(): string {
  return path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'fs-default-')), 'data');
}

afterEach(() => {
  resetDefaultFileStoreForTesting();
  if (origDataDir === undefined) delete process.env.STUDIO_DATA_DIR;
  else process.env.STUDIO_DATA_DIR = origDataDir;
});

describe('file-store-default', () => {
  it('未钉定时按 env 解析根惰性建实例，同根同实例', () => {
    const root = mkRoot();
    process.env.STUDIO_DATA_DIR = root;
    const a = getDefaultFileStore();
    expect(a).toBeInstanceOf(FileStore);
    expect(a.getDataDir()).toBe(root);
    expect(getDefaultFileStore()).toBe(a);
  });

  it('env 变根 → 新实例（与历史改 env 后新构造等价）', () => {
    process.env.STUDIO_DATA_DIR = mkRoot();
    const a = getDefaultFileStore();
    const newRoot = mkRoot();
    process.env.STUDIO_DATA_DIR = newRoot;
    const b = getDefaultFileStore();
    expect(b).not.toBe(a);
    expect(b.getDataDir()).toBe(newRoot);
  });

  it('setDefaultFileStore 钉定后恒返回钉定实例，env 变化不影响', () => {
    const pinned = new FileStore(mkRoot());
    setDefaultFileStore(pinned);
    expect(getDefaultFileStore()).toBe(pinned);
    process.env.STUDIO_DATA_DIR = mkRoot();
    expect(getDefaultFileStore()).toBe(pinned);
  });

  it('resetDefaultFileStoreForTesting 清除钉定与缓存，恢复惰性', () => {
    const pinned = new FileStore(mkRoot());
    setDefaultFileStore(pinned);
    resetDefaultFileStoreForTesting();
    const root = mkRoot();
    process.env.STUDIO_DATA_DIR = root;
    const lazy = getDefaultFileStore();
    expect(lazy).not.toBe(pinned);
    expect(lazy.getDataDir()).toBe(root);
  });
});
