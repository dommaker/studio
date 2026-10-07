/**
 * KnowledgeService — Unified knowledge capability layer
 *
 * Single owner of all knowledge capabilities. Not a facade — real implementation.
 * All consumers (Pipeline Agents, Channel, External Agent Runtime, Studio UI)
 * access knowledge through KnowledgeService.
 *
 * 6 capabilities（#669 沿能力边界拆分，纯结构移动不改行为；本文件为门面：
 * prototype 方法面 33 不变，方法为薄封装委托实现模块）：
 *   Produce  — write knowledge (extract, record)        → knowledge-produce.ts
 *   Consume  — read knowledge (search, inject context)  → knowledge-consume.ts
 *   Track    — record consumption + outcomes            → knowledge-track.ts
 *   Lifecycle — promote, decay, merge, graduate         → knowledge-lifecycle.ts
 *   Resolve  — known problem→fix management             → 本文件（动态 import resolution.service，体量为薄封装）
 *   Measure  — flywheel metrics, health, audit, accuracy → knowledge-measure.ts
 *
 * 支撑模块（工单 29 既有拆分）：
 *   knowledge-types.ts              — Studio 侧类型 + KnowledgeServiceDeps + ENTRY_TYPE_MAP（#669 刀1 归位正本）
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
  execMcpLocalRagQuery,
  resolveKnowledgeEntryId,
} from './knowledge-semantic-search.js';
// 注入常量正本在 knowledge-consume.ts（#669 刀3），re-export 保持导出面不变
export { INJECT_TOKEN_BUDGET, KNOWLEDGE_QUERY_GUIDANCE } from './knowledge-consume.js';
// #669 拆分：六能力实现体（模块级函数，不占 prototype 方法数）
import {
  extractFromExecutionImpl,
  extractFromConversationImpl,
  recordPatternImpl,
  recordIncidentImpl,
  recordTrendImpl,
  recordAnalystAccuracyImpl,
} from './knowledge-produce.js';
import {
  injectContextImpl,
  semanticSearchImpl,
  searchImpl,
  searchKeywordImpl,
  searchSemanticImpl,
  searchHybridImpl,
} from './knowledge-consume.js';
import type { RagProbeState } from './knowledge-consume.js';
import { recordConsumptionImpl, recordOutcomeImpl, recordSkillExecutionImpl } from './knowledge-track.js';
import { promoteImpl, demoteImpl, decayImpl, mergeImpl, graduateConstraintImpl } from './knowledge-lifecycle.js';
import {
  getFlywheelMetricsImpl,
  getHealthReportImpl,
  getAuditReportImpl,
  getAnalystAccuracyImpl,
  getStatsImpl,
} from './knowledge-measure.js';

// #654：事件文件路径一律调用时 resolveStudioEventsFile() 解析，不做加载期钉死常量

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

// ── KnowledgeService ─────────────────────────────────────────

export class KnowledgeService {
  private readonly deps: KnowledgeServiceDeps;
  /** R4 接线回归测试（knowledge-service-inject-wiring）经实例 introspect query 是否为 UnifiedQuery */
  private readonly query: any;
  /** E2（断点 G）：mcp-local-rag 可用性探测缓存（实例字段，不占 prototype 方法数） */
  private readonly ragProbe: RagProbeState = { cache: null };

  constructor(deps: KnowledgeServiceDeps) {
    this.deps = deps;
    this.query = deps.query;
  }

  // ═══════════ Produce (write knowledge) — 实现体 knowledge-produce.ts（#669）════════════

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

  // ═══════════ Consume (read knowledge) — 实现体 knowledge-consume.ts（#669）════════════

  async injectContext(agentType: string, opts?: InjectOpts): Promise<InjectContextResult> {
    return injectContextImpl(this.deps, agentType, opts);
  }

  /**
   * Semantic search via mcp-local-rag CLI.
   * E2（断点 G）：可用性探测（每实例缓存 ragProbe，TTL 5min）+ 失败降级关键词检索。
   * 实现体在 knowledge-consume.ts semanticSearchImpl（含完整契约注释）；
   * 探测/映射逻辑为模块级函数 —— KnowledgeService 公共方法数被
   * knowledge-service.test.ts 锁定（33），不在 prototype 上新增方法。
   */
  async semanticSearch(query: string, opts?: { limit?: number }): Promise<SemanticSearchResult[]> {
    return semanticSearchImpl(this.deps, this.ragProbe, query, opts);
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
    return searchImpl(this.deps, this.ragProbe, query, opts);
  }

  /**
   * Keyword search (original behavior). 实现体 knowledge-consume.ts searchKeywordImpl。
   */
  private searchKeyword(query: string, opts?: SearchOpts): SearchResult[] {
    return searchKeywordImpl(this.deps, query, opts);
  }

  /**
   * Semantic-only search via mcp-local-rag. 实现体 knowledge-consume.ts searchSemanticImpl。
   */
  private async searchSemantic(query: string, limit: number): Promise<SearchResult[]> {
    return searchSemanticImpl(this.deps, this.ragProbe, query, limit);
  }

  /**
   * Hybrid search: keyword + semantic, merged and deduplicated.
   * 实现体 knowledge-consume.ts searchHybridImpl。
   */
  private async searchHybrid(query: string, limit: number): Promise<SearchResult[]> {
    return searchHybridImpl(this.deps, this.ragProbe, query, limit);
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

  // ═══════════ Track (consumption + outcome tracking) — 实现体 knowledge-track.ts（#669）════════════

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

  // ═══════════ Lifecycle — 实现体 knowledge-lifecycle.ts（#669）════════════

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

  // ═══════════ Measure (metrics + audit) — 实现体 knowledge-measure.ts（#669）════════════

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

// ── Singleton ────────────────────────────────────────────────

import { EventEmitter } from 'events';
import {
  sharedStore,
  sharedLifecycle,
  sharedIngest,
  sharedLinter,
} from './knowledge-singletons.js';
import { UnifiedQuery } from './engine/unified-query.js';


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
