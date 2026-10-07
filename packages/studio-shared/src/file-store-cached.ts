/**
 * FileStoreCachedBase — 读穿缓存覆盖层（#670 自 file-store.ts 拆出，PURE_MOVE）
 *
 * ─── 读穿缓存覆盖（A1，工单 26）───
 *
 * 基类（file-store-base.ts）读写原语在此覆盖为带 mtime 校验的读穿缓存版本；
 * FileStoreWorkUnitBase 的方法经虚分派同样走缓存与失效。
 * 缓存共享件（jsonCache/jsonlCache/statMtimeMs/cacheSet/cloneCached/invalidateFileKey）
 * 在 file-store-cache.ts 定义并 import 共用（口径注释见该文件）。
 */

import fs from 'node:fs';
import { isErrnoError } from './file-store-base';
import { applyFilter } from './file-store-workunit';
import { FileStoreMessagesBase } from './file-store-messages';
import { jsonCache, jsonlCache, cacheSet, statMtimeMs, cloneCached, invalidateFileKey } from './file-store-cache';
import { readMetricsBegin, emitReadMetric } from './read-metrics';
import type { WorkUnitSnapshot, WorkUnitFilter } from './file-store-types';

// ─── FileStoreCachedBase 类 ───

export class FileStoreCachedBase extends FileStoreMessagesBase {

  public async readJson<T>(filePath: string): Promise<T | null> {
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

  /** 写入 JSON 文件（原子写），写后失效缓存 */
  public async writeJson(filePath: string, data: unknown): Promise<void> {
    await super.writeJson(filePath, data);
    invalidateFileKey(filePath);
  }

  /** 追加一行 JSONL，写后失效缓存 */
  public async appendJsonl(filePath: string, data: unknown): Promise<void> {
    await super.appendJsonl(filePath, data);
    invalidateFileKey(filePath);
  }

  /** 写入全部 JSONL 行（覆盖），写后失效缓存 */
  public async writeJsonl(filePath: string, data: unknown[]): Promise<void> {
    await super.writeJsonl(filePath, data);
    invalidateFileKey(filePath);
  }

  public async readJsonl<T>(filePath: string): Promise<T[]> {
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

  /** readdirCached / readdir（readdir 读穿缓存公开入口，#321）随消息子域下移为
   *  FileStoreMessagesBase 的 protected / public 成员，本类经继承继续使用。 */

  /**
   * #314（D1）：getIndex 的锁外只读路径走读穿缓存（复用 jsonCache，key =
   * workunits/index.json 绝对路径；所有索引写经 writeJson 覆盖自动精确失效）。
   * 保留 readIndexFile 的严格损坏语义（撕裂/非数组抛错，不静默当空），
   * 命中返回结构克隆。锁内读路径不经过本方法（readIndexFile 保持裸读）。
   * #406：filter 下推——命中路径在共享缓存数组上按引用选行、只克隆命中行
   * （monitor 等带 status 过滤的读口不再为丢弃的行付克隆税）；无 filter 时
   * 全量克隆，与 #314 行为一致。下推只动本锁外读穿路径，锁内裸读不经此 seam。
   */
  protected async readIndexForQuery(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[] | null> {
    const filePath = this.indexPath;
    const t = readMetricsBegin();
    const t0 = t?.() ?? 0;
    const mtimeMs = await statMtimeMs(filePath);
    const t1 = t?.() ?? 0;
    if (mtimeMs === null) {
      jsonCache.delete(filePath);
      if (t) emitReadMetric({ file: filePath, op: 'readIndexForQuery', cacheHit: false, statMs: t1 - t0, readParseMs: 0, cloneMs: 0 });
      return null;
    }
    const hit = jsonCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      // 共享缓存数组上按引用选行（applyFilter 不 mutate），克隆只发生在命中子集上
      const matched = hit.value === null ? null : applyFilter(hit.value as WorkUnitSnapshot[], filter);
      const cached = cloneCached(matched) as WorkUnitSnapshot[] | null;
      if (t) emitReadMetric({ file: filePath, op: 'readIndexForQuery', cacheHit: true, statMs: t1 - t0, readParseMs: 0, cloneMs: t() - t1 });
      return cached;
    }
    const value = await this.readIndexFile();
    const t2 = t?.() ?? 0;
    cacheSet(jsonCache, filePath, { value, mtimeMs });
    const cloned = cloneCached(value === null ? null : applyFilter(value, filter)) as WorkUnitSnapshot[] | null;
    if (t) emitReadMetric({ file: filePath, op: 'readIndexForQuery', cacheHit: false, statMs: t1 - t0, readParseMs: t2 - t1, cloneMs: t() - t2 });
    return cloned;
  }
}
