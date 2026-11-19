/**
 * FileStoreCore 组合设施测试（#681 P1-1）
 *
 * 覆盖：createFileStoreCore 的 baseDir 解析落点、base/io 共享实例语义
 * （各域 store 构造注入同一上下文，缓存读写经 io、裸原语经 base）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFileStoreCore } from '../file-store/file-store-core';
import { FileStoreBase } from '../file-store/file-store-base';
import { CachedFileIo } from '../file-store/file-store-cached';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-core-test-'));
}

describe('createFileStoreCore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('baseDir 与 base.getDataDir() 同源（解析只发生一次）', () => {
    const ctx = createFileStoreCore(tmpDir);
    expect(ctx.baseDir).toBe(ctx.base.getDataDir());
    expect(ctx.baseDir).toBe(tmpDir);
  });

  it('持有 FileStoreBase 裸原语与 CachedFileIo 读穿缓存两件', () => {
    const ctx = createFileStoreCore(tmpDir);
    expect(ctx.base).toBeInstanceOf(FileStoreBase);
    expect(ctx.io).toBeInstanceOf(CachedFileIo);
  });

  it('io 读穿缓存与 base 指向同一数据根（写后读命中）', async () => {
    const ctx = createFileStoreCore(tmpDir);
    const file = path.join(ctx.baseDir, 'probe.json');
    await ctx.io.writeJson(file, { ok: 1 });
    expect(await ctx.io.readJson(file)).toEqual({ ok: 1 });
    expect(await ctx.base.readJson(file)).toEqual({ ok: 1 });
  });
});
