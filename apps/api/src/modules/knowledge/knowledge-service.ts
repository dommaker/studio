/**
 * KnowledgeService — Unified knowledge capability layer
 *
 * Single owner of all knowledge capabilities. Not a facade — real implementation.
 * All consumers (Pipeline Agents, Channel, External Agent Runtime, Studio UI)
 * access knowledge through KnowledgeService.
 *
 * 6 capabilities:
 *   Produce  — write knowledge (extract, record)
 *   Consume  — read knowledge (search, inject context)
 *   Track    — record consumption + outcomes (feedback loop)
 *   Lifecycle — promote, decay, merge, graduate
 *   Resolve  — known problem→fix management
 *   Measure  — flywheel metrics, health, audit, accuracy
 *
 * #669 拆分（纯结构移动，不改行为；prototype 方法面 33 不变，薄封装委托实现模块）：
 *   knowledge-types.ts              — Studio 侧类型 + KnowledgeServiceDeps + ENTRY_TYPE_MAP（刀1 归位）
 *   knowledge-produce.ts            — Produce 实现体（刀2）
 *   knowledge-track.ts              — Track 实现体（刀2）
 *   knowledge-lifecycle.ts          — Lifecycle 实现体（刀2）
 *   knowledge-measure.ts            — Measure 实现体（刀2）
 * 工单 29 既有拆分：
 *   knowledge-metrics.ts            — Measure 纯函数内核 + 度量类型
 *   trend-data.ts                   — trends 数据层（writeTrendData）
 *   knowledge-form-gate.ts          — 知识形态门禁（validateKnowledgeForm）
 *   conversation-extractor.ts       — R3 会话提取管道（提案卡 #355 起归 review-adapter.ts → review-proposal 正本）
 *   knowledge-semantic-search.ts    — mcp-local-rag 语义检索支撑
 *
 * @see docs/specs/arch/knowledge-service.md
 */

import type {
  KnowledgeEntry,
  QueryFilter,
} from '@dommaker/harness';
import { estimateTokens } from '@dommaker/harness';
import { logger, normalizeToStage, renderWithOverride } from '@dommaker/studio-shared';
import { resolveStudioEventsFile } from '../../utils/studio-events.js';
import type { CreateResolutionInput } from '@dommaker/studio-shared';
// Measure 类型正本在 knowledge-metrics.ts（工单 29），此处 re-export 保持对外导出语义不变
export type { FlywheelMetrics, HealthReport, AuditReport, AuditFinding, AccuracyReport, AccuracyData } from './knowledge-metrics.js';
// trends 数据层与形态门禁已抽到 trend-data.ts / knowledge-form-gate.ts（工单 29），
// 此处 re-export 保持对外导出语义不变
export { writeTrendData } from './trend-data.js';
export { validateKnowledgeForm } from './knowledge-form-gate.js';
export type { FormValidationResult } from './knowledge-form-gate.js';
import { registerKnowledgeReviewAdapter } from './review-adapter.js';
// 语义检索/RAG 支撑已抽到 knowledge-semantic-search.ts（工单 29）
import {
  RAG_PROBE_TTL_MS,
  probeMcpLocalRag,
  execMcpLocalRagQuery,
  resolveKnowledgeEntryId,
  keywordHitsToSemantic,
} from './knowledge-semantic-search.js';
// #669 刀2：Produce/Track/Lifecycle/Measure 实现体（模块级函数，不占 prototype 方法数）
import {
  extractFromExecutionImpl,
  extractFromConversationImpl,
  recordPatternImpl,
  recordIncidentImpl,
  recordTrendImpl,
  recordAnalystAccuracyImpl,
} from './knowledge-produce.js';
import { recordConsumptionImpl, recordOutcomeImpl, recordSkillExecutionImpl } from './knowledge-track.js';
import { promoteImpl, demoteImpl, decayImpl, mergeImpl, graduateConstraintImpl } from './knowledge-lifecycle.js';
import {
  getFlywheelMetricsImpl,
  getHealthReportImpl,
  getAuditReportImpl,
  getAnalystAccuracyImpl,
  getStatsImpl,
} from './knowledge-measure.js';

// ── Type mapping (absorbed from KnowledgeBus)：正本 knowledge-types.ts（#669 刀1 归位）──

// #654：事件文件路径一律调用时 resolveStudioEventsFile() 解析，不做加载期钉死常量

// ── Stop words for keyword extraction ──

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'this', 'that', 'these', 'those', 'it', 'its',
  '需要', '实现', '增加', '修改', '支持', '添加', '使用', '一个',
]);

const TYPE_WEIGHT: Record<string, number> = {
  pitfall: 3, pattern: 2, guideline: 2, fix: 2,
  process: 1, analysis: 1, trend: 1,
};

// ── Studio-side types：正本 knowledge-types.ts（#669 归位），re-export 保持导出面不变 ──

import type {
  PatternEntry,
  IncidentEntry,
  TrendEntry,
  AnalystAccuracyInput,
  ExtractionResult,
  ConversationExtractionCtx,
  ExecutionOutcome,
  InjectContextResult,
  InjectOpts,
  SearchOpts,
  SemanticSearchResult,
  SearchResult,
  KnowledgeServiceDeps,
} from './knowledge-types.js';
export type {
  PatternEntry,
  IncidentEntry,
  TrendEntry,
  AnalystAccuracyInput,
  ExtractionResult,
  ConversationExtractionCtx,
  ExecutionOutcome,
  InjectContextResult,
  InjectOpts,
  SearchOpts,
  SemanticSearchResult,
  SearchResult,
  KnowledgeServiceDeps,
} from './knowledge-types.js';

/**
 * E2 检索主动性（断点 G）：知识上下文注入时附带的「何时查知识库」指引。
 * signal 档只注入索引，agent 需要知道何时、如何主动检索全文。
 * 入口 = worktree `.claude/settings.json` 里注册的 local-rag MCP server
 * （studio-agent worktree-resolver propagateHarnessConfig 写入；agent CLI 以
 * worktree 为 cwd 启动，自动加载该配置），工具名 `mcp__local-rag__query_documents`。
 * 体量实测 = 182 tokens（执法口径 estimateTokens(本段 + '\n\n')；内容 4 行），
 * 占注入红线 INJECT_TOKEN_BUDGET=927 约两成（19.6%）——有注入时必附加，但不是小额开销。
 */
export const KNOWLEDGE_QUERY_GUIDANCE = [
  '## 何时查知识库',
  '- 遇到不熟悉的报错、同一问题反复失败、涉及用户偏好、或大改/重构之前：先查知识库再动手。',
  '- 查询入口：MCP 工具 `mcp__local-rag__query_documents`（local-rag server），query 传关键词或问题描述。',
  '- 有现成经验就复用，不要重复踩坑；查不到再自行解决。',
].join('\n');

// ── KnowledgeService ─────────────────────────────────────────

export class KnowledgeService {
  private readonly deps: KnowledgeServiceDeps;
  /** R4 接线回归测试（knowledge-service-inject-wiring）经实例 introspect query 是否为 UnifiedQuery */
  private readonly query: any;
  /** E2（断点 G）：mcp-local-rag 可用性探测缓存（实例字段，不占 prototype 方法数） */
  private ragProbeCache: { available: boolean; checkedAt: number } | null = null;

  constructor(deps: KnowledgeServiceDeps) {
    this.deps = deps;
    this.query = deps.query;
  }

  // ═══════════ Produce (write knowledge) — 实现体 knowledge-produce.ts（#669 刀2）════════════

  async extractFromExecution(result: ExtractionResult): Promise<void> {
    return extractFromExecutionImpl(this.deps, result);
  }

  /**
   * R3 会话提取（断点 B）：任务 COMPLETE 时由 agent-loop 触发一次 LLM 提取。
   * 实现体在 knowledge-produce.ts extractFromConversationImpl（含完整契约注释）。
   */
  async extractFromConversation(
    messages: { role: string; content: string }[],
    ctx?: ConversationExtractionCtx,
  ): Promise<void> {
    return extractFromConversationImpl(this.deps, messages, ctx);
  }

  async recordPattern(entry: PatternEntry): Promise<void> {
    return recordPatternImpl(this.deps, entry);
  }

  async recordIncident(entry: IncidentEntry): Promise<void> {
    return recordIncidentImpl(this.deps, entry);
  }

  async recordTrend(entry: TrendEntry): Promise<void> {
    return recordTrendImpl(this.deps, entry);
  }

  async recordAnalystAccuracy(data: AnalystAccuracyInput): Promise<void> {
    return recordAnalystAccuracyImpl(this.deps, data);
  }

  // ═══════════ Consume (read knowledge) ════════════

  async injectContext(agentType: string, opts?: InjectOpts): Promise<InjectContextResult> {
    const injectedIds: string[] = [];
    // §10 依赖项：maxTokens 做实（此前 _opts 未生效，注入红线只有度量无运行时截断）。
    // 缺省回退 INJECT_TOKEN_BUDGET——#91 起 prompt 组装按分段软定额传入有效预算（knowledge 定额 + 池余量）。
    const maxTokens = opts?.maxTokens ?? INJECT_TOKEN_BUDGET;

    // 1. rule — full content injection (constraints must be followed)
    // R3: isInjectableMaturity — proposal(draft)/archived/deprecated 不注入
    // ②（wireups）：来源凭证读生产字段 sourceReferences（复数，length>0），
    // 此前误读单数 sourceReference → 生产恒 false，rule/context 两档恒空。
    // #612：agentType（= wu.type，可能带 legacy 值 feature/bug/task）先经 normalizeToStage
    // 归一化到阶段词表再过滤——applicableAgents 为阶段词表（决策 8 单一词表），
    // 不归一化则 legacy WU 与阶段定向规则零交集，rule 段再度恒空。
    const stageAgentType = normalizeToStage(agentType);
    const rules = await this.deps.query.queryEntries({ consumptionModes: ['rule'], agentType: stageAgentType, status: 'published' });
    const filteredRules = (rules || []).filter((r: any) => hasSourceReferences(r) && !isRoleMemory(r) && r.status !== 'stale' && isInjectableMaturity(r.maturity));

    // 2. context — full content injection (preferences + environment)
    const context = await this.deps.query.queryEntries({ consumptionModes: ['context'], status: 'published' });
    const filteredContext = (context || []).filter((c: any) => hasSourceReferences(c) && !isRoleMemory(c) && c.status !== 'stale' && isInjectableMaturity(c.maturity));

    // 3. signal — index injection (informational)
    const signals = this.deps.query.getIndexes({ consumptionModes: ['signal'], limit: 5 });
    const filteredSignals = (signals || []).filter((s: any) => !isRoleMemory(s) && s.status !== 'stale' && isInjectableMaturity(s.maturity));

    // ③（wireups）：注入红线（INJECT_TOKEN_BUDGET）执行 — 候选按注入优先级（成熟度 → 引用计数）排序，
    // 逐个累加 estimateTokens（harness 尺子口径），超预算截断并记 knowledge:inject-trimmed 事件。
    interface Candidate { line: string; id: string }
    const toCandidates = (entries: any[], lineOf: (e: any) => string): Candidate[] =>
      entries
        .map(e => ({ line: lineOf(e), id: e.id as string, entry: e }))
        .sort((a, b) => injectPriority(b.entry) - injectPriority(a.entry))
        .map(({ line, id }) => ({ line, id }));

    // #602 D3：E1 prompt-template 提案生效落点 —— 「## 系统约束」段经 renderWithOverride
    // 渲染（无覆盖文件时 fallback 即原模板，行为零变化）。token 计量按渲染后文本，
    // 避免 override 前缀使注入红线截断口径漂移。
    const sectionOverhead = (s: { header: string; templateId?: string }): string =>
      s.templateId
        ? renderWithOverride(s.templateId, `${s.header}\n{content}`, { content: '' })
        : `${s.header}\n`;
    const renderSection = (s: { header: string; templateId?: string }, body: string): string =>
      s.templateId
        // fallback 直接给渲染完的原文（override 缺失时零变化）；override 存在时
        // 其 {content} 占位符被 body 替换（无占位符则 body 追加其后）
        ? renderWithOverride(s.templateId, `${s.header}\n${body}`, { content: body })
        : `${s.header}\n${body}`;

    const sectionCandidates: Array<{ header: string; templateId?: string; items: Candidate[] }> = [
      { header: '## 系统约束', templateId: 'knowledge.rules-section', items: toCandidates(filteredRules, (r: any) => `- ${stripFormat(r.content)}`) },
      { header: '## 上下文', items: toCandidates(filteredContext, (c: any) => `- ${stripFormat(c.content)}`) },
      { header: '## 近期信号', items: toCandidates(filteredSignals, (s: any) => `- [${s.id}] ${s.summary}`) },
    ];

    const sections: string[] = [];
    const trimmedIds: string[] = [];
    let usedTokens = 0;
    // 预算内给检索指引预留（有注入时必附加；实测 182 tokens，约占红线两成，见 KNOWLEDGE_QUERY_GUIDANCE 头注）
    const guidanceTokens = estimateTokens(KNOWLEDGE_QUERY_GUIDANCE + '\n\n');

    // #91: 未截断的原始尺寸（inject-trimmed / section_trimmed 埋点的尺寸字段，
    // 口径与下方 kept 一致：header + 行 + reference 提示 + 检索指引）
    let originalTokens = 0;
    for (const section of sectionCandidates) {
      if (section.items.length === 0) continue;
      originalTokens += estimateTokens(sectionOverhead(section) + '\n');
      for (const item of section.items) originalTokens += estimateTokens(item.line + '\n');
    }

    for (const section of sectionCandidates) {
      if (section.items.length === 0) continue;
      const headerTokens = estimateTokens(sectionOverhead(section) + '\n'); // 渲染后 overhead + 段落分隔
      const keptLines: string[] = [];
      for (const item of section.items) {
        const lineTokens = estimateTokens(item.line + '\n');
        const cost = (keptLines.length === 0 ? headerTokens : 0) + lineTokens;
        if (usedTokens + cost + guidanceTokens > maxTokens) {
          trimmedIds.push(item.id);
          continue;
        }
        usedTokens += cost;
        keptLines.push(item.line);
        injectedIds.push(item.id);
      }
      if (keptLines.length > 0) sections.push(renderSection(section, keptLines.join('\n')));
    }

    // 4. reference — hint only
    const refCount = await this.deps.query.count({ consumptionModes: ['reference'] });
    if (refCount > 0) {
      const hint = `[知识库: ${refCount} 条参考，遇到问题时用 search()]`;
      const hintTokens = estimateTokens(hint + '\n\n');
      originalTokens += hintTokens;
      if (usedTokens + hintTokens + guidanceTokens <= maxTokens) {
        sections.push(hint);
        usedTokens += hintTokens;
      }
    }

    // #91: 检索指引在「有任何注入内容（含 reference 提示）」时附加，原始尺寸口径同 kept
    if (originalTokens > 0 || refCount > 0) originalTokens += guidanceTokens;

    // 5. E2 检索主动性（断点 G）：有知识注入时附「何时查知识库」指引 —
    // signal 档只有索引，agent 需显式指引才会主动检索。无注入时不附加。
    if (sections.length > 0) {
      sections.push(KNOWLEDGE_QUERY_GUIDANCE);
      usedTokens += guidanceTokens;
    }

    // ③: 裁剪事件 — 沿用 studio-events.jsonl 事件写入路径（best-effort）
    if (trimmedIds.length > 0) {
      try {
        await getStore().appendJsonl(resolveStudioEventsFile(), {
          type: 'knowledge:inject-trimmed',
          source: 'inject-context',
          payload: JSON.stringify({
            agentType,
            budgetTokens: maxTokens,
            keptTokens: usedTokens,
            originalTokens,
            keptIds: injectedIds,
            trimmedIds,
            trimmedCount: trimmedIds.length,
          }),
          createdAt: new Date().toISOString(),
        });
      } catch { /* non-blocking */ }
      logger.info('[KnowledgeService] injectContext trimmed to token budget', {
        agentType, budgetTokens: maxTokens, keptTokens: usedTokens, trimmedCount: trimmedIds.length,
      });
    }

    // 6. recordReference — close maturity loop
    if (injectedIds.length > 0) {
      for (const id of injectedIds) {
        try { this.deps.lifecycle.recordReference(id, 'prompt-inject'); } catch { /* non-blocking */ }
      }
    }

    return { prompt: sections.join('\n\n'), injectedIds, usage: { originalTokens, keptTokens: usedTokens } };
  }

  /**
   * Semantic search via mcp-local-rag CLI.
   * Calls `mcp-local-rag query <text>` and parses JSON output.
   * Maps filePath back to knowledge entry ID via YAML frontmatter.
   *
   * E2（断点 G）：先探测 RAG 可用性（每进程缓存，TTL 5min），不可用或查询失败时
   * 降级为 store 关键词检索（searchKeyword），不再静默返回 []。
   * 探测/映射逻辑为模块级函数 —— KnowledgeService 公共方法数被
   * knowledge-service.test.ts 锁定（33），不在 prototype 上新增方法。
   */
  async semanticSearch(query: string, opts?: { limit?: number }): Promise<SemanticSearchResult[]> {
    const limit = opts?.limit || 5;

    // 可用性探测：TTL 内命中缓存直接复用，避免每次查询都多 spawn 一个探测进程
    if (!this.ragProbeCache || Date.now() - this.ragProbeCache.checkedAt >= RAG_PROBE_TTL_MS) {
      const available = await probeMcpLocalRag();
      this.ragProbeCache = { available, checkedAt: Date.now() };
      if (!available) {
        logger.debug('[KnowledgeService] mcp-local-rag probe failed — semantic search degraded to keyword fallback');
      }
    }
    if (!this.ragProbeCache.available) {
      logger.debug('[KnowledgeService] mcp-local-rag unavailable — keyword fallback', { query });
      return keywordHitsToSemantic(this.searchKeyword(query, { limit }));
    }

    try {
      const raw = await this.execMcpQuery(query);
      const results: SemanticSearchResult[] = JSON.parse(raw);

      // Map filePath → entry ID
      const mapped: SemanticSearchResult[] = [];
      for (const r of results.slice(0, limit)) {
        const entryId = await this.resolveEntryId(r.filePath);
        mapped.push({ ...r, entryId });
      }

      // Record references for matched entries
      for (const r of mapped) {
        if (r.entryId) {
          try { this.deps.lifecycle.recordReference(r.entryId, 'semantic-search'); } catch { /* non-blocking */ }
        }
      }

      return mapped;
    } catch (e) {
      // 探测通过但查询失败（模型缺失/超时等）：TTL 内标记不可用，避免后续查询
      // 每次都白等 30s 超时；同时降级关键词检索而不是静默返回 []。
      this.ragProbeCache = { available: false, checkedAt: Date.now() };
      logger.warn('[KnowledgeService] semanticSearch failed — keyword fallback', { error: String(e) });
      return keywordHitsToSemantic(this.searchKeyword(query, { limit }));
    }
  }

  /**
   * Execute mcp-local-rag query CLI and return stdout JSON.
   * 实现已抽到 knowledge-semantic-search 模块级函数（工单 29），薄封装保持 prototype 方法面不变。
   */
  private execMcpQuery(query: string): Promise<string> {
    return execMcpLocalRagQuery(query);
  }

  /**
   * Resolve knowledge entry ID from a filePath.
   * Reads YAML frontmatter `id:` field; falls back to filename parsing.
   * 实现已抽到 knowledge-semantic-search 模块级函数（工单 29），薄封装保持 prototype 方法面不变。
   */
  private async resolveEntryId(filePath: string): Promise<string> {
    return resolveKnowledgeEntryId(filePath);
  }

  async search(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const mode = opts?.mode || 'keyword';
    const limit = opts?.limit || 5;

    if (mode === 'semantic') {
      return this.searchSemantic(query, limit);
    }
    if (mode === 'hybrid') {
      return this.searchHybrid(query, limit);
    }
    return this.searchKeyword(query, opts);
  }

  /**
   * Keyword search (original behavior).
   */
  private searchKeyword(query: string, opts?: SearchOpts): SearchResult[] {
    try {
      const limit = opts?.limit || 5;
      const all = this.deps.store.list({});
      if (all.length === 0) return [];

      const keywords = extractKeywords(query);
      if (keywords.length === 0) return [];

      const now = Date.now();
      const scored = all
        .filter((e: any) => e.maturity !== 'archived')
        .filter((e: any) => !opts?.type || e.tags?.includes(opts.type))
        .map((e: any) => {
          const titleLower = (e.title || '').toLowerCase();
          const contentLower = (e.content || '').toLowerCase();
          let keywordScore = 0;
          let bestMatchPos = -1;
          for (const kw of keywords) {
            if (titleLower.includes(kw)) keywordScore += 3;
            const pos = contentLower.indexOf(kw);
            if (pos !== -1) {
              keywordScore += 1;
              if (bestMatchPos === -1 || pos < bestMatchPos) bestMatchPos = pos;
            }
          }
          if (keywordScore === 0) return null;

          const typeWeight = TYPE_WEIGHT[e.tags?.[0] || ''] || 1;
          const daysAgo = e.lastReferenced
            ? (now - new Date(e.lastReferenced).getTime()) / 86400000
            : 30;
          const freshness = daysAgo < 7 ? 1.0 : Math.max(0.2, 1 - (daysAgo - 7) / 30);
          const maturityWeight: Record<string, number> = { proven: 1.5, verified: 1.0, draft: 0.5 };
          const mWeight = maturityWeight[e.maturity] || 0.5;
          const qualityPenalty = e.tags?.includes('low_quality') ? 0.3 : 1.0;

          const score = keywordScore * typeWeight * freshness * mWeight * qualityPenalty;
          const matchContext = bestMatchPos >= 0
            ? e.content.slice(Math.max(0, bestMatchPos - 40), bestMatchPos + 160)
            : e.content.slice(0, 200);

          return {
            entry: e,
            score,
            highlights: [matchContext],
          };
        })
        .filter((r: any): r is NonNullable<typeof r> => r !== null)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, limit);

      // Record references for returned entries
      for (const r of scored) {
        try { this.deps.lifecycle.recordReference(r.entry.id, 'search'); } catch { /* non-blocking */ }
      }

      return scored;
    } catch {
      return [];
    }
  }

  /**
   * Semantic-only search via mcp-local-rag.
   */
  private async searchSemantic(query: string, limit: number): Promise<SearchResult[]> {
    const semanticResults = await this.semanticSearch(query, { limit });
    const results: SearchResult[] = [];
    for (const sr of semanticResults) {
      if (!sr.entryId) continue;
      const entry = this.deps.store.get(sr.entryId);
      if (!entry) continue;
      results.push({
        entry,
        score: sr.score,
        highlights: [sr.text.slice(0, 200)],
      });
    }
    return results;
  }

  /**
   * Hybrid search: keyword + semantic, merged and deduplicated.
   * Keyword results take priority; semantic supplements.
   */
  private async searchHybrid(query: string, limit: number): Promise<SearchResult[]> {
    const keywordResults = this.searchKeyword(query, { limit });
    const seenIds = new Set(keywordResults.map(r => r.entry.id));

    const semanticResults = await this.semanticSearch(query, { limit });
    for (const sr of semanticResults) {
      if (!sr.entryId || seenIds.has(sr.entryId)) continue;
      seenIds.add(sr.entryId);
      const entry = this.deps.store.get(sr.entryId);
      if (!entry) continue;
      keywordResults.push({
        entry,
        score: sr.score,
        highlights: [sr.text.slice(0, 200)],
      });
    }

    return keywordResults
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async list(filter?: QueryFilter): Promise<KnowledgeEntry[]> {
    // UnifiedQuery.listEntries 返回 { entries, total }（分页形态）；本方法对外保持数组契约。
    const result: any = await this.deps.query.listEntries(filter || {});
    return Array.isArray(result) ? result : (result?.entries ?? []);
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    return this.deps.store.get(id) ?? null;
  }

  async create(entry: KnowledgeEntry): Promise<void> {
    this.deps.store.save(entry);
  }

  async update(id: string, partial: Partial<KnowledgeEntry>): Promise<KnowledgeEntry | undefined> {
    return this.deps.store.update(id, partial);
  }

  async delete(id: string): Promise<boolean> {
    return this.deps.store.delete(id);
  }

  // ═══════════ Track (consumption + outcome tracking) — 实现体 knowledge-track.ts（#669 刀2）════════════

  recordConsumption(entryIds: string[], context: string): void {
    return recordConsumptionImpl(this.deps, entryIds, context);
  }

  async recordOutcome(outcome: ExecutionOutcome): Promise<void> {
    return recordOutcomeImpl(this.deps, outcome);
  }

  /**
   * AC-8c: Record Skill execution outcome back to source KnowledgeEntry.
   * 实现体在 knowledge-track.ts recordSkillExecutionImpl（含完整契约注释）。
   */
  async recordSkillExecution(skillId: string, success: boolean, agentType: string): Promise<void> {
    return recordSkillExecutionImpl(this.deps, skillId, success, agentType);
  }

  // ═══════════ Lifecycle — 实现体 knowledge-lifecycle.ts（#669 刀2）════════════

  async promote(entryId: string): Promise<void> {
    return promoteImpl(this.deps, entryId);
  }

  /**
   * 审核闭环 reject 语义：draft → archived（保留追溯，decay/lint 不再管它，永不注入）。
   * 实现体在 knowledge-lifecycle.ts demoteImpl。
   */
  async demote(entryId: string): Promise<void> {
    return demoteImpl(this.deps, entryId);
  }

  async decay(entryId: string): Promise<void> {
    return decayImpl(this.deps, entryId);
  }

  async merge(sourceId: string, targetId: string): Promise<void> {
    return mergeImpl(this.deps, sourceId, targetId);
  }

  async graduateConstraint(id: string): Promise<void> {
    return graduateConstraintImpl(this.deps, id);
  }

  // ═══════════ Resolve (known solutions) ════════════

  /**
   * R3（type-repair）：写入 resolutionService 主存储（~/.studio/knowledge/resolution-*.md）。
   * 按 pattern 去重由 resolutionService.createResolution 负责。
   * triage 调用方签名不变（Promise<void>）；失败 best-effort 吞掉。
   */
  async createResolution(input: CreateResolutionInput): Promise<void> {
    try {
      // 动态 import：避免模块加载期循环依赖
      const { resolutionService } = await import('./resolution.service.js');
      await resolutionService.createResolution(input);
    } catch {
      // best-effort
    }
  }

  // ═══════════ Measure (metrics + audit) — 实现体 knowledge-measure.ts（#669 刀2）════════════

  async getFlywheelMetrics(opts?: { eventsFile?: string; windowDays?: number }) {
    return getFlywheelMetricsImpl(this.deps, opts);
  }

  async getHealthReport() {
    return getHealthReportImpl(this.deps);
  }

  /**
   * M1: 实算审计报告（断点 I 修复，此前返回空 stub）。
   * 实现体在 knowledge-measure.ts getAuditReportImpl（含完整契约注释）。
   */
  async getAuditReport(opts?: { eventsFile?: string; windowDays?: number }) {
    return getAuditReportImpl(this.deps, opts);
  }

  /**
   * M1 诚实实现：系统中不存在 analyst 预测 vs 实际结果的结构化数据源，返回不可用标记而非假空 stub。
   */
  async getAnalystAccuracy() {
    return getAnalystAccuracyImpl(this.deps);
  }

  // ═══════════ Additional methods (absorbed from KnowledgeBus / ResolutionService) ════════════

  /**
   * 知识统计概览 — absorbed from KnowledgeBus.getStats()
   */
  getStats(): Record<string, number> {
    return getStatsImpl(this.deps);
  }
}

// ── Utilities (absorbed from KnowledgeBus / prompt-builder) ──

// ── R3 会话提取 + 提案闸门 ──

// R3 会话提取管道（transcript 构建 / 提案入库 / 提案卡）已抽到 conversation-extractor.ts（工单 29）

/**
 * R3 提案闸门：draft/archived/deprecated 不参与注入。
 * proposal（LLM 提取产物，maturity=draft）须经人工审核 promote 后才可注入。
 * 无 maturity 字段的条目（doc 来源 rule/preference/snapshot，恒为 approved 语义）不受限。
 */
const NON_INJECTABLE_MATURITIES: ReadonlySet<string> = new Set(['draft', 'archived', 'deprecated']);

function isInjectableMaturity(maturity: unknown): boolean {
  return typeof maturity !== 'string' || !NON_INJECTABLE_MATURITIES.has(maturity);
}

/** ②（wireups）：生产条目来源凭证字段是 sourceReferences（复数数组），length>0 才算有凭证。 */
function hasSourceReferences(entry: any): boolean {
  return Array.isArray(entry?.sourceReferences) && entry.sourceReferences.length > 0;
}

/** #93：知识库收窄为项目级共享知识 —— 角色记忆（#100 per-role MEMORY.md 体系）不进注入段。
 *  守卫约定：角色记忆条目若误入 KB，须带 'role-memory' tag，注入闸门在此拦截。 */
function isRoleMemory(entry: any): boolean {
  return Array.isArray(entry?.tags) && entry.tags.includes('role-memory');
}

/** ③（wireups）：注入 token 预算（vision D6「注入 ≤2K tokens」红线执行点）。
 *  harness 1.16.0 换 estimateTokens 新尺子后按「旧窗口反推」换算：用真实渲染器对本仓知识条目
 *  内容类（英文为主夹少量中文，旧尺子整串 /1.5 高估）产出的注入全文，取旧尺子在旧 2000 下
 *  放行的最长前缀，再读新尺子 = 927；与 monitoring INJECTED_TOKEN_BUDGET 同数，
 *  推导即测试正本见 agents/__tests__/prompt-composer.test.ts「九段定额换尺子反推（推导即测试 = 定数正本）」块。 */
export const INJECT_TOKEN_BUDGET = 927;

/**
 * ③（wireups）：注入优先级 = 成熟度权重 × 10000 + 引用计数。
 * 成熟度高的先注入；同成熟度按 referencedBy 计数（被引用越多越有价值）。
 */
function injectPriority(entry: any): number {
  const maturityWeight: Record<string, number> = { proven: 3, verified: 2, active: 2, draft: 1 };
  const w = maturityWeight[entry?.maturity] ?? 0;
  const refs = Array.isArray(entry?.referencedBy) ? entry.referencedBy.length : 0;
  return w * 10_000 + refs;
}

function extractKeywords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）\(\)\[\]{}<>\/\\|@#$%^&*+=~`!\-_]+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

function stripFormat(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .trim();
}

// ── Singleton ────────────────────────────────────────────────

import { EventEmitter } from 'events';
import {
  sharedStore,
  sharedLifecycle,
  sharedIngest,
  sharedLinter,
} from './knowledge-singletons.js';
import { UnifiedQuery } from './engine/unified-query.js';
import { getStore } from '../../core/store.js';


// R4 修复（生产接线 bug）：query 必须是 UnifiedQuery（injectContext/list 依赖
// queryEntries/getIndexes/count/listEntries），此前误接 harness KnowledgeQuery
// （无这些方法）导致 injectContext 在生产抛 queryEntries is not a function，
// 被 agent-loop try/catch 吞掉 —— 生产实际从未注入知识。
// UnifiedQuery 显式复用 sharedStore（同一 FileKnowledgeStore 实例），
// 保证 dedup/recordReference/成熟度闸门语义一致。
export const knowledgeService = new KnowledgeService({
  store: sharedStore,
  lifecycle: sharedLifecycle,
  ingest: sharedIngest,
  linter: sharedLinter,
  query: new UnifiedQuery(sharedStore),
  eventEmitter: new EventEmitter(),
});

// #355：knowledge 人审提案 adapter 运行时装配（kind='knowledge'，review-proposal 正本）。
// 模块加载即注册，保证重启后存量 pending 提案可经通用端点审批（同 kind 重复注册幂等）。
registerKnowledgeReviewAdapter();
