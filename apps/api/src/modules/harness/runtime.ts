/**
 * runtime.ts — Harness 路由共享运行时
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），供各子路由共享：
 * - @dommaker/harness 懒加载（S13: typed lazy-loaded harness modules）
 * - TraceCollector / TraceAnalyzer / FileKnowledgeStore / KnowledgeQuery 单例
 * - TTL 响应缓存（慢端点性能优化）
 *
 * harnessModule 为 export let 活绑定：仅本文件在 loadHarness 中赋值，
 * 子路由以只读方式引用（ESM live binding 保证读到加载后的模块）。
 */

import { UNIFIED_KNOWLEDGE_DIR } from '../knowledge/knowledge-bus.service.js';
import type {
  TraceCollector as TraceCollectorType,
  TraceAnalyzer as TraceAnalyzerType,
  KnowledgeStore as KnowledgeStoreType,
  KnowledgeQuery as KnowledgeQueryType,
} from '@dommaker/harness';

// S13: typed lazy-loaded harness modules
export type HarnessModule = typeof import('@dommaker/harness');
export let harnessModule: HarnessModule | null = null;

let harnessLoading: Promise<boolean> | null = null;
export async function loadHarness(): Promise<boolean> {
  if (harnessModule) return true;
  if (!harnessLoading) {
    harnessLoading = import('@dommaker/harness').then(m => {
      harnessModule = m;
      return true;
    }).catch(() => {
      harnessLoading = null;
      return false;
    });
  }
  return harnessLoading;
}

// Typed singletons
let collector: TraceCollectorType | null = null;
let analyzer: TraceAnalyzerType | null = null;

// Performance: TTL response cache for slow endpoints
const cacheStore = new Map<string, { data: unknown; expiresAt: number }>();
export function getCached<T>(key: string, ttlMs: number = 30000): T | undefined {
  const entry = cacheStore.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.data as T;
  cacheStore.delete(key);
  return undefined;
}
export function setCache(key: string, data: unknown, ttlMs: number = 30000): void {
  cacheStore.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export async function getCollector(): Promise<TraceCollectorType | null> {
  if (!collector) {
    const loaded = await loadHarness();
    if (!loaded || !harnessModule) return null;
    collector = new harnessModule.TraceCollector();
  }
  return collector;
}

export async function getAnalyzer(): Promise<TraceAnalyzerType | null> {
  if (!analyzer) {
    const c = await getCollector();
    if (!c) return null;
    if (!harnessModule) return null;
    analyzer = new harnessModule.TraceAnalyzer(c);
  }
  return analyzer;
}

// ─── Knowledge Engine (T-010) store singletons ───

let knowledgeStore: KnowledgeStoreType | null = null;
let knowledgeQuery: KnowledgeQueryType | null = null;

export async function getKnowledgeStore(): Promise<KnowledgeStoreType | null> {
  if (!knowledgeStore) {
    const loaded = await loadHarness();
    if (!loaded || !harnessModule) return null;
    knowledgeStore = new harnessModule.FileKnowledgeStore({ baseDir: UNIFIED_KNOWLEDGE_DIR });
    knowledgeQuery = new harnessModule.KnowledgeQuery(knowledgeStore);
  }
  return knowledgeStore;
}

export async function getKnowledgeQuery(): Promise<KnowledgeQueryType | null> {
  await getKnowledgeStore();
  return knowledgeQuery;
}
