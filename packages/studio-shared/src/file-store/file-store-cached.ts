/**
 * CachedFileIo — 读穿缓存读写原语（#681 P1-1 组合化：自 FileStoreCachedBase 覆盖层转型）
 *
 * 继承链时代本层以「覆盖基类 readJson/readJsonl/写后失效」的形态叠加在链上；
 * 组合化后本类是读穿缓存的唯一实现（不再有「基类裸读缺省 + 覆盖」双形态）：
 * 各域 store 的默认读写路径经 FileStoreCore.io 走本类，锁内/跨进程实时路径
 * 经 FileStoreCore.base 走 FileStoreBase 裸原语（ADR 例外条款）。
 *
 * 承载：readJson/readJsonl（mtime 校验读穿缓存 + 命中克隆）、writeJson/appendJsonl/
 * writeJsonl（委托 base 原子写 + 写后失效）、readdirCached/readdir（目录读穿缓存，
 * #321；自 file-store-messages-core.ts 迁入——它本是通用件，被 entities/seq/docs/
 * messages 四域共用）。WorkUnit 索引读口 readIndexForQuery 随域留在 file-store-workunit.ts。
 *
 * 缓存共享件（jsonCache/jsonlCache/dirCache/statMtimeMs/cacheSet/cloneCached/
 * invalidateFileKey）在 cache-primitives.ts 定义并 import 共用（口径注释见该文件）。
 */

import fs from 'node:fs';
import { isErrnoError, type FileStoreBase } from './file-store-base';
import { dirCache, jsonCache, jsonlCache, cacheSet, statMtimeMs, cloneCached, invalidateFileKey } from './cache-primitives';
import { readMetricsBegin, emitReadMetric } from '../read-metrics';

// ─── CachedFileIo 类 ───

export class CachedFileIo {
  private readonly base: FileStoreBase;

  constructor(base: FileStoreBase) {
    this.base = base;
  }

  /** 读取 JSON 文件（mtime 校验读穿缓存）；不存在或损坏返回 null；命中返回结构克隆 */
  public async readJson<T>(filePath: string): Promise<T | null> {
    await this.base.repairFilePermissions(filePath);
    const t = readMetricsBegin();
    const t0 = t?.() ?? 0;
    const mtimeMs = await statMtimeMs(filePath);
    const t1 = t?.() ?? 0;
    if (mtimeMs === null) {
      jsonCache.delete(filePath);
      if (t) emitReadMetric({ file: filePath, op: 'readJson', cacheHit: false, statMs: t1 - t0, readParseMs: 0, cloneMs: 0 });
      return null;
    }
    const hit = jsonCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      const cached = cloneCached(hit.value) as T | null;
      if (t) emitReadMetric({ file: filePath, op: 'readJson', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: t() - t1 });
      return cached;
    }
    let value: unknown = null;
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      try {
        value = JSON.parse(content);
      } catch {
        value = null; // corrupt JSON → treat as missing
      }
    } catch (err: unknown) {
      if (!isErrnoError(err) || err.code !== 'ENOENT') throw err;
      value = null; // stat 与 readFile 之间被删 → 按缺失处理
    }
    const t2 = t?.() ?? 0;
    cacheSet(jsonCache, filePath, { value, mtimeMs });
    const cloned = cloneCached(value) as T | null;
    if (t) emitReadMetric({ file: filePath, op: 'readJson', cacheHit: false, statMs: t1 - t0, readParseMs: t2 - t1, cloneMs: t() - t2 });
    return cloned;
  }

  /** 写入 JSON 文件（原子写，委托 base），写后失效缓存；派生物可显式 sync=false。 */
  public async writeJson(filePath: string, data: unknown, sync = true): Promise<void> {
    await this.base.writeJson(filePath, data, sync);
    invalidateFileKey(filePath);
  }

  /** 追加一行 JSONL（委托 base），写后失效缓存 */
  public async appendJsonl(filePath: string, data: unknown): Promise<void> {
    await this.base.appendJsonl(filePath, data);
    invalidateFileKey(filePath);
  }

  /** 写入全部 JSONL 行（覆盖，委托 base 原子写），写后失效缓存 */
  public async writeJsonl(filePath: string, data: unknown[]): Promise<void> {
    await this.base.writeJsonl(filePath, data);
    invalidateFileKey(filePath);
  }

  /** 读取全部 JSONL 行（mtime 校验读穿缓存；跳过解析失败的行）；命中返回结构克隆 */
  public async readJsonl<T>(filePath: string): Promise<T[]> {
    await this.base.repairFilePermissions(filePath);
    const t = readMetricsBegin();
    const t0 = t?.() ?? 0;
    const mtimeMs = await statMtimeMs(filePath);
    const t1 = t?.() ?? 0;
    if (mtimeMs === null) {
      jsonlCache.delete(filePath);
      if (t) emitReadMetric({ file: filePath, op: 'readJsonl', cacheHit: false, statMs: t1 - t0, readParseMs: 0, cloneMs: 0 });
      return [];
    }
    const hit = jsonlCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      const cached = cloneCached(hit.value) as T[];
      if (t) emitReadMetric({ file: filePath, op: 'readJsonl', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: t() - t1 });
      return cached;
    }
    let rows: unknown[] = [];
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const results: unknown[] = [];
      for (const line of lines) {
        try {
          results.push(JSON.parse(line));
        } catch {
          // skip corrupt lines
        }
      }
      rows = results;
    } catch (err: unknown) {
      if (!isErrnoError(err) || err.code !== 'ENOENT') throw err;
      rows = []; // stat 与 readFile 之间被删 → 按空处理
    }
    const t2 = t?.() ?? 0;
    cacheSet(jsonlCache, filePath, { value: rows, mtimeMs });
    const cloned = cloneCached(rows) as T[];
    if (t) emitReadMetric({ file: filePath, op: 'readJsonl', cacheHit: false, statMs: t1 - t0, readParseMs: t2 - t1, cloneMs: t() - t2 });
    return cloned;
  }

  /** readdir（withFileTypes）读穿缓存：目录 mtime 校验，目录内容增删触发重读 */
  public async readdirCached(dir: string): Promise<fs.Dirent[]> {
    const t = readMetricsBegin();
    const t0 = t?.() ?? 0;
    const mtimeMs = await statMtimeMs(dir);
    const t1 = t?.() ?? 0;
    if (mtimeMs === null) {
      dirCache.delete(dir);
      const fallback = await fs.promises.readdir(dir, { withFileTypes: true }); // 保留 ENOENT 抛错语义
      if (t) emitReadMetric({ file: dir, op: 'readdir', cacheHit: false, statMs: t1 - t0, readParseMs: t() - t1, cloneMs: 0 });
      return fallback;
    }
    const hit = dirCache.get(dir);
    if (hit && hit.mtimeMs === mtimeMs) {
      if (t) emitReadMetric({ file: dir, op: 'readdir', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: 0 });
      return hit.value;
    }
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    if (t) emitReadMetric({ file: dir, op: 'readdir', cacheHit: false, statMs: t1 - t0, readParseMs: t() - t1, cloneMs: 0 });
    cacheSet(dirCache, dir, { value: entries, mtimeMs });
    return entries;
  }

  /**
   * readdir 读穿缓存公开入口（#321）：聚合读层（library/sdd-legacy）扫外部仓目录用。
   * 目录 mtime 校验；目录不存在抛 ENOENT（与 fs.readdir 语义一致，调用方自行容错）。
   */
  public async readdir(dir: string): Promise<fs.Dirent[]> {
    return this.readdirCached(dir);
  }
}
