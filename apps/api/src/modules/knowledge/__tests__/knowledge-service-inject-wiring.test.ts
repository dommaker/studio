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

  it('#93: rule/context sections non-empty when rule/preference entries exist (sourceReferences gate)', async () => {
    // #93 修复前：UnifiedQuery 合成条目 sourceReferences 恒 [] → hasSourceReferences 闸门全拦，
    // 即使 store 里有 rule/preference 数据，'## 系统约束' / '## 上下文' 两段也恒空。
    // 种子用生产形状：store 条目本身 sourceReferences 可以为空，出处由合成端（ruleToEntry/
    // preferenceToEntry）从 store 条目 id 派生。
    const now = new Date().toISOString();
    sharedStore.save({
      id: `rule-wiring-${Math.random().toString(36).slice(2, 8)}`,
      type: 'guideline',
      title: 'wiring_rule',
      content: JSON.stringify({ name: 'wiring_rule', category: 'constraint', description: 'R4WIRING-RULE-CONTENT 接线验证规则', affects: '[]', status: 'active' }),
      maturity: 'active', layer: 'system', created: now, lastReferenced: now,
      contributors: [], projects: [], tags: ['rule', 'active'], applicablePhases: [],
      sourceReferences: [], referencedBy: [], executionResults: [],
      consumptionMode: 'reference', origin: 'system',
    });
    sharedStore.save({
      id: `pref-wiring-${Math.random().toString(36).slice(2, 8)}`,
      type: 'guideline',
      title: '用户偏好',
      content: JSON.stringify({ preferredModel: 'R4WIRING-PREF-MODEL', updatedAt: now }),
      maturity: 'active', layer: 'system', created: now, lastReferenced: now,
      contributors: [], projects: [], tags: ['preference', 'user-default'], applicablePhases: [],
      sourceReferences: [], referencedBy: [], executionResults: [],
      consumptionMode: 'reference', origin: 'system',
    });

    const result = await knowledgeService.injectContext('wiring-test-agent');

    // rule 段（'## 系统约束'）与 context 段（'## 上下文'）均非空
    expect(result.prompt).toContain('## 系统约束');
    expect(result.prompt).toContain('R4WIRING-RULE-CONTENT');
    expect(result.prompt).toContain('## 上下文');
    expect(result.prompt).toContain('R4WIRING-PREF-MODEL');
  });

  it('#93: role-memory tagged entries are never injected (KB = project-level shared knowledge only)', async () => {
    // 边界守卫：角色记忆（#100 per-role MEMORY.md 体系）不属于知识库注入范围。
    // 若未来有人把角色记忆写进 KB，只要带 'role-memory' tag，注入闸门必须拦住——
    // 即使它凭证齐全、成熟度可注入。
    const now = new Date().toISOString();
    sharedStore.save({
      id: `rolemem-wiring-${Math.random().toString(36).slice(2, 8)}`,
      type: 'guideline',
      title: '角色记忆误入样本',
      content: 'R4WIRING-ROLE-MEMORY 绝不应注入',
      maturity: 'verified', layer: 'project', created: now, lastReferenced: now,
      contributors: [], projects: [], tags: ['role-memory'], applicablePhases: [],
      sourceReferences: [{ source: 'test:role-memory', timestamp: now }] as any,
      referencedBy: [], executionResults: [],
      consumptionMode: 'signal', origin: 'agent',
    });

    const result = await knowledgeService.injectContext('wiring-test-agent');

    expect(result.prompt).not.toContain('R4WIRING-ROLE-MEMORY');
  });

  it('#602 D3: knowledge.rules-section override file re-renders the 系统约束 section', async () => {
    // E1 prompt-template 提案生效落点：applier 写 ~/.studio/prompt-overrides/knowledge.rules-section.md，
    // 知识注入构建处必须读它（此前 renderWithOverride 生产调用点为 0，覆盖文件是死数据）。
    const overridesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-overrides-'));
    fs.writeFileSync(
      path.join(overridesDir, 'knowledge.rules-section.md'),
      '## 系统约束\nR4WIRING-OVERRIDE-PREFIX 以下约束必须逐条遵守：\n{content}',
      'utf-8',
    );
    process.env.STUDIO_PROMPT_OVERRIDES_DIR = overridesDir;
    try {
      const now = new Date().toISOString();
      sharedStore.save({
        id: `rule-override-${Math.random().toString(36).slice(2, 8)}`,
        type: 'guideline',
        title: 'override_rule',
        content: JSON.stringify({ name: 'override_rule', category: 'constraint', description: 'R4WIRING-OVERRIDE-RULE 覆盖验证规则', affects: '[]', status: 'active' }),
        maturity: 'active', layer: 'system', created: now, lastReferenced: now,
        contributors: [], projects: [], tags: ['rule', 'active'], applicablePhases: [],
        sourceReferences: [], referencedBy: [], executionResults: [],
        consumptionMode: 'reference', origin: 'system',
      } as any);

      const result = await knowledgeService.injectContext('wiring-test-agent');

      // override 前缀文本生效，且 {content} 占位符被动态条目替换
      expect(result.prompt).toContain('R4WIRING-OVERRIDE-PREFIX');
      expect(result.prompt).toContain('R4WIRING-OVERRIDE-RULE');
      expect(result.prompt).not.toContain('{content}');
    } finally {
      delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
      fs.rmSync(overridesDir, { recursive: true, force: true });
    }
  });

  it('#602 D3: without override file the 系统约束 section renders exactly as before', async () => {
    // 无覆盖文件 → 零行为变化（fallback 即原模板）
    process.env.STUDIO_PROMPT_OVERRIDES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-overrides-empty-'));
    try {
      const result = await knowledgeService.injectContext('wiring-test-agent');
      expect(result.prompt).toContain('## 系统约束\n- ');
      expect(result.prompt).not.toContain('R4WIRING-OVERRIDE-PREFIX');
    } finally {
      delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
    }
  });

  it('list() adapts UnifiedQuery paged result to an entry array', async () => {
    seedEntries();
    const entries = await knowledgeService.list({ consumptionModes: ['signal'] } as any);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e: any) => e.content.includes('R4WIRING-ACTIVE-CONTENT'))).toBe(true);
  });
});
