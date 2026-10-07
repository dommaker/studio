/**
 * 读穿缓存共享件（#670 自 file-store-messages.ts / file-store.ts 抽出，PURE_MOVE）
 *
 * ─── 读穿缓存（A1，工单 26）───
 *
 * 模块级（同进程共享、按绝对路径为 key），任何 FileStore 实例的写/删都会失效对应 key，
 * 因此同进程内写后读立即可见。命中时用 stat 的 mtimeMs 校验缓存新鲜度，
 * 其他进程的外部写入（mtime 变化）也会触发重读——不引入跨进程脏读。
 * 缓存对象一律不直接外发（命中返回结构克隆），调用方原地 mutate 返回值不会污染缓存。
 *
 * dirCache 是 readdirCached 的读穿缓存（定义在 file-store-messages-core.ts）；
 * statMtimeMs/cacheSet/CacheEntry 是缓存层通用件；json/jsonl/md 缓存与失效件
 * 供 file-store-cached.ts / file-store-entities.ts / file-store-docs.ts 共用。
 * 全部 export 仅供模块间共享，不进包 index。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isErrnoError } from './file-store-base';

export interface CacheEntry<T> {
  value: T;
  mtimeMs: number;
}

export const dirCache = new Map<string, CacheEntry<fs.Dirent[]>>();
export const MAX_CACHE_ENTRIES = 1000;

export function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>): void {
  if (map.size >= MAX_CACHE_ENTRIES) map.clear();
  map.set(key, entry);
}

/** 文件/目录 mtimeMs；不存在返回 null；其他错误抛出（与 readFile 错误语义一致） */
export async function statMtimeMs(target: string): Promise<number | null> {
  try {
    const st = await fs.promises.stat(target);
    return st.mtimeMs;
  } catch (err: unknown) {
    if (isErrnoError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

export const jsonCache = new Map<string, CacheEntry<unknown>>();
export const jsonlCache = new Map<string, CacheEntry<unknown[]>>();
export const mdCache = new Map<string, CacheEntry<{ meta: Record<string, unknown>; body: string } | null>>();

/** 缓存值外发前结构克隆（null 直返），防调用方原地 mutate 污染缓存 */
export function cloneCached<T>(value: T): T {
  return value === null || value === undefined ? value : structuredClone(value);
}

/** Promise.all 读文件结果收集：null（缺失/损坏/被过滤）丢弃，保持输入序。泛型谓词在 filter 上不可用，显式循环为先例写法 */
export function collectNonNull<T>(results: Array<T | null>): T[] {
  const items: T[] = [];
  for (const r of results) {
    if (r !== null) items.push(r);
  }
  return items;
}

/** 写路径失效：精确删除对应文件 key；目录级 list 缓存清空（新建文件/目录可能落在同一 mtime 粒度内，不能只靠 mtime 校验） */
export function invalidateFileKey(filePath: string): void {
  jsonCache.delete(filePath);
  jsonlCache.delete(filePath);
  mdCache.delete(filePath);
  dirCache.clear();
}

/** 删路径失效：文件或目录（递归）下所有 key + 目录级 list 缓存 */
export function invalidateRemovedPath(target: string): void {
  const prefix = target.endsWith(path.sep) ? target : target + path.sep;
  for (const map of [jsonCache, jsonlCache, mdCache] as const) {
    for (const key of map.keys()) {
      if (key === target || key.startsWith(prefix)) map.delete(key);
    }
  }
  dirCache.clear();
}
