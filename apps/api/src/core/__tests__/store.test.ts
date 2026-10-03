/**
 * core/store.ts 单测：init 钉定 / get 惰性兜底 / env 变根新实例 / reset 恢复惰性。
 * 隔离：vitest setup 已把 STUDIO_DATA_DIR 钉到本进程临时根；本文件的 env 改动
 * 一律在 afterEach 复原并 resetStoreForTesting()。
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { initStore, getStore, resetStoreForTesting } from '../store.js';

const origDataDir = process.env.STUDIO_DATA_DIR;

afterEach(() => {
  resetStoreForTesting();
  if (origDataDir === undefined) delete process.env.STUDIO_DATA_DIR;
  else process.env.STUDIO_DATA_DIR = origDataDir;
});

describe('core/store', () => {
  it('getStore 未 init 时惰性兜底：返回 FileStore 且数据根 = env 解析根', () => {
    const store = getStore();
    expect(store).toBeInstanceOf(FileStore);
    expect(store.getDataDir()).toBe(process.env.STUDIO_DATA_DIR);
  });

  it('getStore 惰性面按根缓存：同根同实例，env 变根 → 新实例', () => {
    const a = getStore();
    expect(getStore()).toBe(a);

    const tmpHome = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'store-test-'));
    const newRoot = path.join(tmpHome, 'data');
    process.env.STUDIO_DATA_DIR = newRoot;
    const b = getStore();
    expect(b).not.toBe(a);
    expect(b.getDataDir()).toBe(newRoot);
  });

  it('initStore(root) 钉定后 getStore 恒返回钉定实例，env 变化不影响', () => {
    const tmpHome = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'store-test-'));
    const root = path.join(tmpHome, 'data');
    const pinned = initStore(root);
    expect(pinned.getDataDir()).toBe(root);
    expect(getStore()).toBe(pinned);

    process.env.STUDIO_DATA_DIR = path.join(tmpHome, 'other-data');
    expect(getStore()).toBe(pinned);
  });

  it('initStore() 无参 = env 解析根（与历史无参构造一致）', () => {
    const pinned = initStore();
    expect(pinned.getDataDir()).toBe(process.env.STUDIO_DATA_DIR);
    expect(getStore()).toBe(pinned);
  });

  it('resetStoreForTesting 清除钉定，恢复 env 惰性兜底', () => {
    const tmpHome = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'store-test-'));
    const pinned = initStore(path.join(tmpHome, 'data'));
    resetStoreForTesting();
    const lazy = getStore();
    expect(lazy).not.toBe(pinned);
    expect(lazy.getDataDir()).toBe(process.env.STUDIO_DATA_DIR);
  });
});
