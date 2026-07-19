/**
 * R4 回归测试 — 生产 knowledgeService 单例接线（断点 E/H 修复验证）
 *
 * 背景（已验证的生产 bug）：knowledge-service.ts 模块单例此前以
 * `query: sharedQuery`（harness KnowledgeQuery）构造，但 injectContext/list
 * 依赖 queryEntries/getIndexes/count/listEntries —— KnowledgeQuery 没有这些方法
 * （它们在 studio 的 UnifiedQuery 上）。结果：生产 injectContext 抛
 * "queryEntries is not a function"，被 agent-loop try/catch 吞掉，
 * 生产 prompt 实际从未注入知识。
 *
 * 本测试：
 * - 以模块级单例（与 index.ts 生产装配完全同款构造）驱动 injectContext；
 * - knowledge-singletons mock 成 tmp 目录上的真实 harness 组件
 *   （避免 pkill / 真实 ~/.studio 副作用，构造参数与生产一致）；
 * - 断言：query 是 UnifiedQuery 实例；active 条目被注入；draft（proposal）
 *   条目被 R3 提案闸门排除（getIndexes 的 draft 过滤 + isInjectableMaturity）。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 生产同款共享单例 — 真实 harness 类，tmp baseDir（构造参数同 knowledge-singletons.ts）
vi.mock('../knowledge-singletons.js', async () => {
  const fsMod = await import('fs');
  const pathMod = await import('path');
  const osMod = await import('os');
  const tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'ks-wiring-'));

  const harness = await vi.importActual<any>('@dommaker/harness');
  const { FileKnowledgeStore, KnowledgeLifecycle, KnowledgeIngest, KnowledgeQuery, KnowledgeInjector, KnowledgeLinter, ReferenceTracker } = harness;

  const sharedStore = new FileKnowledgeStore({ baseDir: tmpDir });
  const sharedLifecycle = new KnowledgeLifecycle(sharedStore, {
    autoPromoteSources: ['triage', 'auditor', 'evolution', 'analyst'],
  });
  const sharedIngest = new KnowledgeIngest(sharedStore);
  const sharedQuery = new KnowledgeQuery(sharedStore, sharedLifecycle);
  const sharedInjector = new KnowledgeInjector(sharedQuery);
  const sharedLinter = new KnowledgeLinter(sharedStore, new ReferenceTracker(sharedStore));

  return {
    UNIFIED_KNOWLEDGE_DIR: tmpDir,
    sharedStore,
    sharedLifecycle,
    sharedIngest,
    sharedQuery,
    sharedInjector,
    sharedLinter,
    scheduleVectorDbSync: vi.fn(),
    ingestWithQualityGate: vi.fn(),
    appendKnowledgeEvent: vi.fn(),
    verifyConsumptionChain: vi.fn().mockResolvedValue(true),
    isVectorDbSyncing: () => false,
  };
});

import { knowledgeService } from '../knowledge-service.js';
import { UnifiedQuery } from '../engine/unified-query.js';
import { sharedStore, sharedIngest, UNIFIED_KNOWLEDGE_DIR } from '../knowledge-singletons.js';

const ACTIVE_MARKER = 'R4WIRING-ACTIVE-CONTENT 生产接线验证：此 active 条目必须出现在注入 prompt 中';
const DRAFT_MARKER = 'R4WIRING-DRAFT-CONTENT 提案（draft）绝不应出现在注入 prompt 中';

function seedEntries() {
  // 标题/内容刻意拉开距离，避免 harness ingest 语义去重（标题重叠 ≥0.6 合并）把两条并掉
  const active = sharedIngest.ingestEntry(
    { type: 'guideline', title: 'Alpha wiring probe guideline', content: ACTIVE_MARKER, tags: ['pattern'] },
    { source: 'pattern:wiring-test', layer: 'project', maturity: 'active', tags: ['pattern'], consumptionMode: 'signal' },
  );
  const draft = sharedIngest.ingestEntry(
    { type: 'guideline', title: 'Zeta proposal draft pitfall', content: DRAFT_MARKER, tags: ['pattern'] },
    { source: 'pattern:wiring-test', layer: 'project', maturity: 'draft', tags: ['pattern'], consumptionMode: 'signal' },
  );
  return { active, draft };
}

afterAll(() => {
  try { fs.rmSync(UNIFIED_KNOWLEDGE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('R4 regression: production knowledgeService wiring (injectContext)', () => {
  it('module singleton is wired with UnifiedQuery (not harness KnowledgeQuery)', () => {
    // 修复前：query 是 KnowledgeQuery —— injectContext 第一步就抛
    // "query.queryEntries is not a function"
    expect((knowledgeService as any).query).toBeInstanceOf(UnifiedQuery);
    // 且复用共享 FileKnowledgeStore（同一 store 实例，dedup/成熟度语义一致）
    expect((knowledgeService as any).query.store).toBe(sharedStore);
  });

  it('injectContext returns active entry content and excludes draft (previously threw)', async () => {
    const { active, draft } = seedEntries();

    // 修复前此调用抛 TypeError，被 agent-loop 吞掉 → 生产无注入
    const result = await knowledgeService.injectContext('wiring-test-agent');

    // active 条目（signal 索引注入）
    expect(result.prompt).toContain('R4WIRING-ACTIVE-CONTENT');
    expect(result.injectedIds).toContain(active.id);

    // draft 提案被排除（R3 提案闸门：getIndexes draft 过滤 + isInjectableMaturity）
    expect(result.prompt).not.toContain('R4WIRING-DRAFT-CONTENT');
    expect(result.injectedIds).not.toContain(draft.id);
  });

  it('list() adapts UnifiedQuery paged result to an entry array', async () => {
    seedEntries();
    const entries = await knowledgeService.list({ consumptionModes: ['signal'] } as any);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e: any) => e.content.includes('R4WIRING-ACTIVE-CONTENT'))).toBe(true);
  });
});
