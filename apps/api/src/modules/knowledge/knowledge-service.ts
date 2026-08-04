/**
 * KnowledgeService — Unified knowledge capability layer
 *
 * Single owner of all knowledge capabilities. Not a facade — real implementation.
 * All consumers (Pipeline Agents, Channel, External Agent Runtime, Studio UI)
 * access knowledge through KnowledgeService.
 *
 * 6 capabilities:
 *   Produce  — write knowledge (extract, record)
 *   Consume  — read knowledge (search, inject context, match resolutions)
 *   Track    — record consumption + outcomes (feedback loop)
 *   Lifecycle — promote, decay, merge, graduate
 *   Resolve  — known problem→fix management
 *   Measure  — flywheel metrics, health, audit, accuracy
 *
 * @see docs/specs/arch/knowledge-service.md
 */

import type {
  KnowledgeEntry,
  KnowledgeStore,
  KnowledgeIngest,
  KnowledgeLifecycle,
  KnowledgeLinter,
  QueryFilter,
  MaturityLevel,
} from '@dommaker/harness';
import { logger, estimateTokens } from '@dommaker/studio-shared';
import { getSystemExecutor, StudioRoleNotConfiguredError } from '../agents/system-executor.js';
import type { CreateResolutionInput, MatchResolutionResult, Resolution } from '@dommaker/studio-shared';
import { scheduleVectorDbSync, ingestWithQualityGate } from './knowledge-singletons.js';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import * as path from 'path';
import { ENTRY_TYPE_MAP } from './knowledge-types.js';
import type {
  KnowledgeServiceDeps,
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
  FlywheelMetrics,
  HealthReport,
  AuditReport,
  AuditFinding,
  AccuracyReport,
} from './knowledge-types.js';
import { fileStore, STUDIO_EVENTS_JSONL, writeTrendData, RESOLUTIONS_DIR, listResolutions } from './knowledge-data-layer.js';
import {
  KNOWLEDGE_QUERY_GUIDANCE,
  INJECT_TOKEN_BUDGET,
  isInjectableMaturity,
  hasSourceReferences,
  injectPriority,
  stripFormat,
} from './inject-context.js';
import { buildConversationTranscript, ingestConversationEntry, postKnowledgeProposalCard } from './conversation-extraction.js';
import { computeOutcomeMetrics, scanKnowledgeEvents } from './knowledge-metrics.js';
import { TYPE_WEIGHT, extractKeywords, RAG_PROBE_TTL_MS, probeMcpLocalRag, keywordHitsToSemantic } from './knowledge-search-helpers.js';

// ── Re-export：模块级 helpers 已抽出至邻近模块（兼容既有 import 路径） ──
export { writeTrendData } from './knowledge-data-layer.js';
export { validateKnowledgeForm } from './knowledge-forms.js';
export type { FormValidationResult } from './knowledge-forms.js';
export { KNOWLEDGE_QUERY_GUIDANCE, INJECT_TOKEN_BUDGET } from './inject-context.js';
export type {
  PatternEntry,
  IncidentEntry,
  TrendEntry,
  AccuracyData,
  AnalystAccuracyInput,
  ExtractionResult,
  ConversationExtractionCtx,
  ExecutionOutcome,
  InjectContextResult,
  InjectOpts,
  SearchOpts,
  SemanticSearchResult,
  SearchResult,
  FlywheelMetrics,
  HealthReport,
  AuditReport,
  AuditFinding,
  AccuracyReport,
  KnowledgeServiceDeps,
} from './knowledge-types.js';

// ── KnowledgeService ─────────────────────────────────────────

export class KnowledgeService {
  private store: KnowledgeStore;
  private lifecycle: KnowledgeLifecycle;
  private ingest: KnowledgeIngest;
  private linter: KnowledgeLinter;
  private query: any;
  private eventEmitter: any;
  /** E2（断点 G）：mcp-local-rag 可用性探测缓存（实例字段，不占 prototype 方法数） */
  private ragProbeCache: { available: boolean; checkedAt: number } | null = null;

  constructor(deps: KnowledgeServiceDeps) {
    this.store = deps.store;
    this.lifecycle = deps.lifecycle;
    this.ingest = deps.ingest;
    this.linter = deps.linter;
    this.query = deps.query;
    this.eventEmitter = deps.eventEmitter;
  }

  // ═══════════ Produce (write knowledge) ════════════

  async extractFromExecution(result: ExtractionResult): Promise<void> {
    // Extract knowledge patterns from execution diff/task
    if (!result.diff && !result.task) return;

    const title = `[Exec] ${result.agentType}: ${result.task.slice(0, 80)}`;
    const content = [
      `Agent: ${result.agentType}`,
      `Success: ${result.success}`,
      `Duration: ${result.duration}ms`,
      result.diff ? `Diff (${result.diff.length} chars): ${result.diff.slice(0, 500)}` : '',
      result.consumedKnowledge.length > 0 ? `Consumed: ${result.consumedKnowledge.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    // AC-3.1: Failure → mark for review with need_review tag
    const tags = ['execution', result.agentType];
    if (!result.success) {
      tags.push('need_review');
    }

    // AC-3.3: Dedup — check if existing published entry on same topic exists
    const allEntries = this.store.list({});
    const existingSameTopic = allEntries.find((e: any) =>
      e.title && e.title.startsWith(`[Exec] ${result.agentType}:`) &&
      e.title.includes(result.task.slice(0, 40))
    );

    if (existingSameTopic) {
      // Merge: update existing entry with new content
      const mergedContent = `${existingSameTopic.content}\n\n---\n${content}`;
      const updatedRefs = [
        ...(existingSameTopic.sourceReferences || []),
        { source: `execution:${result.agentType}`, timestamp: new Date().toISOString() },
      ];
      this.store.save({ ...existingSameTopic, content: mergedContent, sourceReferences: updatedRefs.slice(-20) });
    } else {
      await this.recordPattern({
        type: result.success ? 'pattern' : 'failure',
        title,
        content,
        tags,
      });
    }

    // Record outcome for consumed knowledge entries
    if (result.consumedKnowledge.length > 0) {
      this.recordConsumption(result.consumedKnowledge, `execution:${result.agentType}`);
    }

    this.eventEmitter.emit('knowledge', { type: 'extractFromExecution', data: { agentType: result.agentType, success: result.success } });

    // B59-002: persist to StudioEvent for OKR queryKnowledgeQualityGatePassRate
    try {
      await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
        type: 'extractFromExecution',
        payload: JSON.stringify({ agentType: result.agentType, success: result.success }),
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      logger.warn('[KnowledgeService] Failed to persist extractFromExecution event', { error: String(e) });
    }
  }

  /**
   * R3 会话提取（断点 B）：任务 COMPLETE 时由 agent-loop 触发一次 LLM 提取
   * （根因/模式/可复用经验），结果以 proposal（maturity=draft）入库。
   *
   * - LLM 路径复用 KnowledgeCurator 的提取链路：systemExecutor.run +
   *   getExtractFromTextSystemPrompt()（单一 prompt 来源，不复制；E1 支持
   *   ~/.studio/prompt-overrides/knowledge.extract-from-text.md 文件覆盖）。
   * - proposal 须经审核（promote → verified）才参与注入（见 injectContext 的
   *   isInjectableMaturity 闸门）；模板式 extractFromExecution 保留为兜底。
   * - 提取开销（tokens/duration）以 knowledge:extraction 事件单独度量，
   *   不计入 2K 注入红线。
   * - 永不抛出：LLM 未配置/调用失败仅记日志（e2e 无 LLM 时静默跳过）。
   */
  async extractFromConversation(
    messages: { role: string; content: string }[],
    ctx?: ConversationExtractionCtx,
  ): Promise<void> {
    const source = ctx?.source ?? `conversation:${ctx?.workUnitId ?? 'unknown'}`;
    try {
      const transcript = buildConversationTranscript(messages);
      if (!transcript) return;

      // 复用 KnowledgeCurator 的提取 prompt（动态 import 避免静态循环依赖：
      // knowledge-curator.service 已静态引用本模块的 validateKnowledgeForm/writeTrendData）
      // E1: 经 getter 取值以支持 prompt-override 文件覆盖（约束进化提案生效路径）
      const { getExtractFromTextSystemPrompt } = await import('../agents/knowledge-curator.service.js');

      const startMs = Date.now();
      const execResult = await getSystemExecutor().run(transcript, {
        systemPrompt: getExtractFromTextSystemPrompt(),
      });
      const durationMs = Date.now() - startMs;
      const result = JSON.parse(execResult.output) as { entries?: Array<{ type?: string; title?: string; content?: string; tags?: string[] }> };

      // 提取开销：systemExecutor.run 返回的 usage（CLI --output-format json envelope）
      const promptTokens = execResult.usage?.inputTokens ?? 0;
      const completionTokens = execResult.usage?.outputTokens ?? 0;
      const totalTokens = promptTokens + completionTokens;

      const entries = Array.isArray(result?.entries) ? result.entries.slice(0, 5) : [];
      const ingested: Array<{ id: string; title: string; type: string }> = [];
      for (const raw of entries) {
        const saved = ingestConversationEntry({ linter: this.linter, ingest: this.ingest }, raw, source);
        if (saved) ingested.push(saved);
      }
      const entryIds = ingested.map(e => e.id);
      if (ingested.length > 0) {
        scheduleVectorDbSync();
        // 审核闭环：入库即发提案卡到 #系统（人在频道 approve/reject → promote/demote）。
        // best-effort：频道缺失/发卡失败静默跳过，绝不阻断提取链路。
        await postKnowledgeProposalCard(ingested, { workUnitId: ctx?.workUnitId, source });
      }

      logger.info('[KnowledgeService] extractFromConversation completed', {
        source, entryCount: entryIds.length, totalTokens, durationMs,
      });

      // M2 成本度量：提取开销单独记事件，与注入 tokens 分开核算
      const eventData = {
        trigger: 'task-complete',
        workUnitId: ctx?.workUnitId,
        entryIds,
        entryCount: entryIds.length,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
      };
      this.eventEmitter.emit('knowledge', { type: 'extractFromConversation', data: eventData });
      try {
        await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
          type: 'knowledge:extraction',
          source,
          payload: JSON.stringify(eventData),
          createdAt: new Date().toISOString(),
        });
      } catch (e) {
        logger.warn('[KnowledgeService] Failed to persist knowledge:extraction event', { error: String(e) });
      }
    } catch (err) {
      if (err instanceof StudioRoleNotConfiguredError) {
        logger.info('[KnowledgeService] extractFromConversation skipped: studio role provider not configured', { source });
        return;
      }
      // 提取失败绝不影响任务完成（模板兜底仍由 extractFromExecution 独立承担）
      logger.warn('[KnowledgeService] extractFromConversation failed', { source, error: String(err) });
    }
  }

  async recordPattern(entry: PatternEntry): Promise<void> {
    try {
      const source = entry.tags?.[0] || 'monitor';

      // Merge input tags (e.g., need_review) with type-derived tags
      const tags: string[] = [entry.type, ...(entry.tags || []).filter(t => t !== entry.type)];
      const knowledgeType = ENTRY_TYPE_MAP[entry.type] || 'guideline';

      // R4: 统一质量门（断点 H）— 与 KnowledgeBus.recordPattern 单一路径。
      // triage 业务门 + harness ingest 门（reject 跳过 / flag 自动 low_quality）
      // 均在 ingestWithQualityGate 内处理；studio 侧不再另起 linter 预检。
      ingestWithQualityGate(
        { ingest: this.ingest },
        {
          type: knowledgeType,
          title: entry.title,
          content: entry.content,
          tags,
          source,
          entryType: entry.type,
          layer: 'project',
          maturity: 'active',
          consumptionMode: 'signal',
        },
      );
    } catch {
      // best-effort — don't block producers
    }
  }

  async recordIncident(entry: IncidentEntry): Promise<void> {
    try {
      this.ingest.ingestEntry(
        {
          type: 'pitfall',
          title: entry.title,
          content: entry.content,
          tags: ['incident', entry.severity],
        },
        {
          source: `incident:ops:${new Date().toISOString()}`,
          layer: 'tech',
          maturity: 'active',
          tags: ['incident', entry.severity],
          consumptionMode: 'signal',
        },
      );
      scheduleVectorDbSync();
    } catch {
      // best-effort
    }
  }

  async recordTrend(entry: TrendEntry): Promise<void> {
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const content = `## ${entry.title}\n\n${entry.content}\n\nmetric: ${entry.metric}`;
      writeTrendData(`${dateStr}.md`, content);
      logger.debug('[KnowledgeService] recordTrend → data/', { metric: entry.metric });
    } catch (e) {
      logger.warn('[KnowledgeService] recordTrend failed', { error: String(e) });
    }
  }

  async recordAnalystAccuracy(data: AnalystAccuracyInput): Promise<void> {
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const missedFiles = data.predictedFiles.filter(f => !data.actualFiles.includes(f));
      const extraFiles = data.actualFiles.filter(f => !data.predictedFiles.includes(f));
      const missedDeps = data.predictedDeps.filter(d => !data.actualDeps.includes(d));

      const content = [
        `## AnalystAccuracy: ${data.goalTitle.slice(0, 80)}`,
        ``,
        `- AC匹配率: ${Math.round(data.acMatchRate * 100)}%`,
        `- 预测文件: [${data.predictedFiles.join(', ')}]`,
        `- 实际文件: [${data.actualFiles.join(', ')}]`,
        missedFiles.length > 0 ? `- 漏预测: [${missedFiles.join(', ')}]` : '',
        extraFiles.length > 0 ? `- 多预测: [${extraFiles.join(', ')}]` : '',
        missedDeps.length > 0 ? `- 漏依赖: [${missedDeps.join(', ')}]` : '',
      ].filter(Boolean).join('\n');

      writeTrendData(`${dateStr}.md`, content);
      logger.debug('[KnowledgeService] recordAnalystAccuracy → data/');
    } catch (e) {
      logger.warn('[KnowledgeService] recordAnalystAccuracy failed', { error: String(e) });
    }
  }

  // ═══════════ Consume (read knowledge) ════════════

  async injectContext(agentType: string, opts?: InjectOpts): Promise<InjectContextResult> {
    const injectedIds: string[] = [];
    // §10 依赖项：maxTokens 做实（此前 _opts 未生效，2K 红线只有度量无运行时截断）。
    // 缺省回退 INJECT_TOKEN_BUDGET——skill 段优先占用预算时由调用方传入剩余额度。
    const maxTokens = opts?.maxTokens ?? INJECT_TOKEN_BUDGET;

    // 1. rule — full content injection (constraints must be followed)
    // R3: isInjectableMaturity — proposal(draft)/archived/deprecated 不注入
    // ②（wireups）：来源凭证读生产字段 sourceReferences（复数，length>0），
    // 此前误读单数 sourceReference → 生产恒 false，rule/context 两档恒空。
    const rules = await this.query.queryEntries({ consumptionModes: ['rule'], agentType, status: 'published' });
    const filteredRules = (rules || []).filter((r: any) => hasSourceReferences(r) && r.status !== 'stale' && isInjectableMaturity(r.maturity));

    // 2. context — full content injection (preferences + environment)
    const context = await this.query.queryEntries({ consumptionModes: ['context'], status: 'published' });
    const filteredContext = (context || []).filter((c: any) => hasSourceReferences(c) && c.status !== 'stale' && isInjectableMaturity(c.maturity));

    // 3. signal — index injection (informational)
    const signals = this.query.getIndexes({ consumptionModes: ['signal'], limit: 5 });
    const filteredSignals = (signals || []).filter((s: any) => s.status !== 'stale' && isInjectableMaturity(s.maturity));

    // ③（wireups）：2K 注入红线执行 — 候选按注入优先级（成熟度 → 引用计数）排序，
    // 逐个累加 estimateTokens（chars/4 现有口径），超 2000 截断并记 knowledge:inject-trimmed 事件。
    interface Candidate { line: string; id: string }
    const toCandidates = (entries: any[], lineOf: (e: any) => string): Candidate[] =>
      entries
        .map(e => ({ line: lineOf(e), id: e.id as string, entry: e }))
        .sort((a, b) => injectPriority(b.entry) - injectPriority(a.entry))
        .map(({ line, id }) => ({ line, id }));

    const sectionCandidates: Array<{ header: string; items: Candidate[] }> = [
      { header: '## 系统约束', items: toCandidates(filteredRules, (r: any) => `- ${stripFormat(r.content)}`) },
      { header: '## 上下文', items: toCandidates(filteredContext, (c: any) => `- ${stripFormat(c.content)}`) },
      { header: '## 近期信号', items: toCandidates(filteredSignals, (s: any) => `- [${s.id}] ${s.summary}`) },
    ];

    const sections: string[] = [];
    const trimmedIds: string[] = [];
    let usedTokens = 0;
    // 预算内给检索指引预留（有注入时必附加，属红线内固定小额开销）
    const guidanceTokens = estimateTokens(KNOWLEDGE_QUERY_GUIDANCE.length + 2);

    for (const section of sectionCandidates) {
      if (section.items.length === 0) continue;
      const headerTokens = estimateTokens(section.header.length + 2); // header + 段落分隔
      const keptLines: string[] = [];
      for (const item of section.items) {
        const lineTokens = estimateTokens(item.line.length + 1);
        const cost = (keptLines.length === 0 ? headerTokens : 0) + lineTokens;
        if (usedTokens + cost + guidanceTokens > maxTokens) {
          trimmedIds.push(item.id);
          continue;
        }
        usedTokens += cost;
        keptLines.push(item.line);
        injectedIds.push(item.id);
      }
      if (keptLines.length > 0) sections.push(`${section.header}\n${keptLines.join('\n')}`);
    }

    // 4. reference — hint only
    const refCount = await this.query.count({ consumptionModes: ['reference'] });
    if (refCount > 0) {
      const hint = `[知识库: ${refCount} 条参考，遇到问题时用 search()]`;
      const hintTokens = estimateTokens(hint.length + 2);
      if (usedTokens + hintTokens + guidanceTokens <= maxTokens) {
        sections.push(hint);
        usedTokens += hintTokens;
      }
    }

    // 5. E2 检索主动性（断点 G）：有知识注入时附「何时查知识库」指引 —
    // signal 档只有索引，agent 需显式指引才会主动检索。无注入时不附加。
    if (sections.length > 0) {
      sections.push(KNOWLEDGE_QUERY_GUIDANCE);
      usedTokens += guidanceTokens;
    }

    // ③: 裁剪事件 — 沿用 studio-events.jsonl 事件写入路径（best-effort）
    if (trimmedIds.length > 0) {
      try {
        await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
          type: 'knowledge:inject-trimmed',
          source: 'inject-context',
          payload: JSON.stringify({
            agentType,
            budgetTokens: maxTokens,
            keptTokens: usedTokens,
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
        try { this.lifecycle.recordReference(id, 'prompt-inject'); } catch { /* non-blocking */ }
      }
    }

    return { prompt: sections.join('\n\n'), injectedIds };
  }

  /**
   * Semantic search via mcp-local-rag CLI.
   * Calls `mcp-local-rag query <text>` and parses JSON output.
   * Maps filePath back to knowledge entry ID via YAML frontmatter.
   *
   * E2（断点 G）：先探测 RAG 可用性（每进程缓存，TTL 5min），不可用或查询失败时
   * 降级为 store 关键词检索（searchKeyword），不再静默返回 []。
   * 探测/映射逻辑为模块级函数 —— KnowledgeService 公共方法数被
   * knowledge-service.test.ts 锁定（34），不在 prototype 上新增方法。
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
          try { this.lifecycle.recordReference(r.entryId, 'semantic-search'); } catch { /* non-blocking */ }
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
   */
  private execMcpQuery(query: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--db-path', join(process.env.HOME || '/root', '.cache', 'mcp-local-rag', 'lancedb'),
        '--cache-dir', join(process.env.HOME || '/root', '.cache', 'huggingface', 'hub'),
        '--model-name', join(process.env.HOME || '/root', '.cache', 'huggingface', 'hub', 'models--onnx-community--bge-small-zh-v1.5-ONNX', 'snapshots', 'main'),
        'query', query,
      ];
      execFile('mcp-local-rag', args, { timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) {
          // mcp-local-rag logs to stderr, stdout has JSON result even on partial error
          if (stdout && stdout.trim().startsWith('[')) {
            resolve(stdout);
          } else {
            reject(err);
          }
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Resolve knowledge entry ID from a filePath.
   * Reads YAML frontmatter `id:` field; falls back to filename parsing.
   */
  private async resolveEntryId(filePath: string): Promise<string> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const match = content.match(/^---[\s\S]*?^id:\s*(.+)$/m);
      if (match) return match[1].trim();
    } catch { /* file not readable */ }

    // Fallback: parse filename pattern "{type}-{id}.md"
    const name = basename(filePath, '.md');
    const dashIdx = name.indexOf('-');
    return dashIdx > 0 ? name.slice(dashIdx + 1) : name;
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
      const all = this.store.list({});
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
        try { this.lifecycle.recordReference(r.entry.id, 'search'); } catch { /* non-blocking */ }
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
      const entry = this.store.get(sr.entryId);
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
      const entry = this.store.get(sr.entryId);
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

  async matchResolutions(problem: string): Promise<MatchResolutionResult> {
    try {
      const all = await listResolutions();
      const candidates = all
        .filter((r: any) => r.status === 'verified' || r.status === 'canonical')
        .sort((a: any, b: any) => (b.verifyCount || 0) - (a.verifyCount || 0));

      const matched: Resolution[] = [];
      const lowerMsg = problem.toLowerCase();

      for (const row of candidates) {
        const pattern = row.pattern;
        let isMatch = false;

        // Try regex first
        try {
          const re = new RegExp(pattern, 'i');
          if (re.test(problem)) isMatch = true;
        } catch {
          // Not valid regex, fall back to substring
          if (lowerMsg.includes(pattern.toLowerCase())) isMatch = true;
        }

        if (isMatch) {
          matched.push({
            id: row.id,
            pattern: row.pattern,
            errorClass: row.errorClass || '',
            layer: row.layer || 'L5_error_fix',
            title: row.title || pattern,
            fix: row.fix || '',
            status: row.status,
            verifyCount: row.verifyCount || 0,
            tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
            createdAt: row.createdAt || '',
            updatedAt: row.updatedAt || '',
          });
        }
      }

      const promptSnippet = matched.length > 0
        ? matched.map(r => `[Known Fix] ${r.title}: ${r.fix}`).join('\n')
        : '';

      return { matched: matched.length > 0, resolutions: matched, promptSnippet };
    } catch {
      return { matched: false, resolutions: [], promptSnippet: '' };
    }
  }

  async list(filter?: QueryFilter): Promise<KnowledgeEntry[]> {
    // UnifiedQuery.listEntries 返回 { entries, total }（分页形态）；本方法对外保持数组契约。
    const result: any = await this.query.listEntries(filter || {});
    return Array.isArray(result) ? result : (result?.entries ?? []);
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    return this.store.get(id);
  }

  async create(entry: KnowledgeEntry): Promise<void> {
    this.store.save(entry);
  }

  async update(id: string, partial: Partial<KnowledgeEntry>): Promise<KnowledgeEntry | undefined> {
    return this.store.update(id, partial);
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  // ═══════════ Track (consumption + outcome tracking) ════════════

  recordConsumption(entryIds: string[], context: string): void {
    for (const id of entryIds) {
      try { this.lifecycle.recordReference(id, context); } catch { /* non-blocking */ }
    }

    // O2-KR1: 发射 consumption 事件供 OKR metric 采集
    if (entryIds.length > 0) {
      fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
        type: 'knowledge:consumption',
        source: context,
        payload: JSON.stringify({ entryIds, count: entryIds.length }),
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  async recordOutcome(outcome: ExecutionOutcome): Promise<void> {
    // Close the feedback loop: record execution outcome as StudioEvent
    try {
      await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
        type: `knowledge:outcome:${outcome.success ? 'success' : 'failure'}`,
        source: outcome.agentType,
        payload: JSON.stringify({
          executionId: outcome.executionId,
          agentType: outcome.agentType,
          success: outcome.success,
          details: outcome.details?.slice(0, 500),
          consumedKnowledge: outcome.consumedKnowledge,
          mode: outcome.mode,
        }),
        createdAt: new Date().toISOString(),
      });
    } catch { /* non-blocking */ }

    // Update referencedBy for consumed knowledge entries
    for (const entryId of outcome.consumedKnowledge) {
      try {
        const entry = this.store.get(entryId);
        if (entry) {
          entry.referencedBy = entry.referencedBy || [];
          if (!entry.referencedBy.includes(outcome.executionId)) {
            entry.referencedBy.push(outcome.executionId);
            this.store.save(entry);
          }
        }
      } catch { /* non-blocking */ }
    }

    this.eventEmitter.emit('knowledge', { type: 'recordOutcome', data: { executionId: outcome.executionId, success: outcome.success } });
  }

  /**
   * AC-8c: Record Skill execution outcome back to source KnowledgeEntry.
   * Finds the KnowledgeEntry that produced the Skill, records execution result.
   * If successRate drops below 50%, revokes skillCandidate tag.
   */
  async recordSkillExecution(skillId: string, success: boolean, agentType: string): Promise<void> {
    try {
      // Find KnowledgeEntry by skillId
      const entries = this.store.list({});
      const sourceEntry = entries.find(e => e.skillId === skillId);
      if (!sourceEntry) return;

      // Record reference with execution result
      this.lifecycle.recordReference(sourceEntry.id, `skill:${agentType}`, success, 'auto');

      // Check if skillCandidate tag should be revoked
      if (this.lifecycle.checkSkillCandidateRevocation) {
        this.lifecycle.checkSkillCandidateRevocation(sourceEntry.id);
      }
    } catch { /* non-blocking */ }
  }

  // ═══════════ Lifecycle ════════════

  async promote(entryId: string): Promise<void> {
    const entry = this.store.get(entryId);
    if (!entry) return;
    const next: Record<string, MaturityLevel> = { draft: 'verified', verified: 'proven' };
    const target = next[entry.maturity];
    if (target) {
      this.store.update(entryId, { maturity: target });
    }
  }

  /**
   * 审核闭环 reject 语义：draft → archived（保留追溯，decay/lint 不再管它，永不注入）。
   * 与 promote 对称；仅 draft 可 demote（verified/proven 的降级走 decay）。
   */
  async demote(entryId: string): Promise<void> {
    const entry = this.store.get(entryId);
    if (!entry) return;
    const prev: Record<string, MaturityLevel> = { draft: 'archived' };
    const target = prev[entry.maturity];
    if (target) {
      this.store.update(entryId, { maturity: target });
    }
  }

  async decay(entryId: string): Promise<void> {
    const entry = this.store.get(entryId);
    if (!entry) return;
    const prev: Record<string, MaturityLevel> = { proven: 'verified', verified: 'draft' };
    const target = prev[entry.maturity];
    if (!target) return;
    // Only decay if stale (unreferenced for threshold)
    const daysSinceRef = entry.lastReferenced
      ? (Date.now() - new Date(entry.lastReferenced).getTime()) / 86400000
      : 999;
    const threshold: Record<string, number> = { proven: 365, verified: 180, draft: 90 };
    if (daysSinceRef >= (threshold[entry.maturity] || 90)) {
      this.store.update(entryId, { maturity: target });
    }
  }

  async merge(sourceId: string, targetId: string): Promise<void> {
    const source = this.store.get(sourceId);
    const target = this.store.get(targetId);
    if (!source || !target) return;
    this.store.save({
      ...target,
      content: `${target.content}\n\n---\nMerged from ${sourceId}: ${source.content}`,
      contributors: [...(target.contributors || []), ...(source.contributors || [])],
    });
    this.store.delete(sourceId);
  }

  async graduateConstraint(_id: string): Promise<void> {
    // Phase 7: constraint → knowledge
  }

  // ═══════════ Resolve (known solutions) ════════════

  /**
   * R3（type-repair）：写入 resolutionService 主存储（~/.studio/knowledge/resolution-*.md），
   * 不再写 ~/.studio/data/resolutions/ 影子库（双库合并：UI/匹配只读主存储）。
   * 按 pattern 去重由 resolutionService.createResolution 负责（语义与原影子库一致）。
   * triage 调用方签名不变（Promise<void>）；失败 best-effort 吞掉。
   */
  async createResolution(input: CreateResolutionInput): Promise<void> {
    try {
      // 动态 import：与 postKnowledgeProposalCard 同款，避免模块加载期循环依赖
      const { resolutionService } = await import('./resolution.service.js');
      await resolutionService.createResolution(input);
    } catch {
      // best-effort
    }
  }

  // ═══════════ Measure (metrics + audit) ════════════

  async getFlywheelMetrics(opts?: { eventsFile?: string; windowDays?: number }): Promise<FlywheelMetrics> {
    const timestamp = new Date().toISOString();
    try {
      const entries = this.store.list({});
      const total = entries.length;

      let quality = 0;
      let freshness = 0;
      if (total > 0) {
        // Quality: weighted maturity score (proven=3, verified=2, draft=1)
        const maturityWeight: Record<string, number> = { proven: 3, verified: 2, active: 1.5, draft: 1, deprecated: 0, archived: 0 };
        const qualitySum = entries.reduce((s: number, e: any) => s + (maturityWeight[e.maturity] || 0), 0);
        quality = Math.min(100, Math.round((qualitySum / (total * 3)) * 100));

        // Freshness: % referenced in last 30 days
        const now = Date.now();
        const recentCount = entries.filter((e: any) =>
          e.lastReferenced && (now - new Date(e.lastReferenced).getTime()) < 30 * 86400000
        ).length;
        freshness = Math.round((recentCount / total) * 100);
      }

      // R1: hitRate / improvement 从 outcome 事件实算（断点 A 修复，此前硬编码 0）
      // 模块级纯函数（不依赖 this），保持 KnowledgeService 公共方法面不变
      const outcomeMetrics = await computeOutcomeMetrics(opts);

      return { quality, hitRate: outcomeMetrics.hitRate, improvement: outcomeMetrics.improvement, freshness, timestamp, source: outcomeMetrics.source };
    } catch {
      return { quality: 0, hitRate: 0, improvement: 0, freshness: 0, timestamp, source: 'insufficient-data' };
    }
  }

  async getHealthReport(): Promise<HealthReport> {
    try {
      const entries = this.store.list({});
      const total = entries.length;
      const now = Date.now();
      const staleThreshold = 30 * 86400000; // 30 days
      const staleEntries = entries.filter((e: any) =>
        !e.lastReferenced || (now - new Date(e.lastReferenced).getTime()) > staleThreshold
      ).length;
      const score = total === 0 ? 0 : Math.round(((total - staleEntries) / total) * 100);
      return {
        score,
        totalEntries: total,
        staleEntries,
        orphanEntries: 0,
        duplicateEntries: 0,
        timestamp: new Date().toISOString(),
      };
    } catch {
      return { score: 0, totalEntries: 0, staleEntries: 0, orphanEntries: 0, duplicateEntries: 0, timestamp: new Date().toISOString() };
    }
  }

  /**
   * M1: 实算审计报告（断点 I 修复，此前返回空 stub）。
   * 数据源：studio-events.jsonl 事件流（consumption/outcome/extraction）+ KnowledgeStore。
   * 事件流无数据的分区返回显式 0 + source='insufficient-data'（与 getFlywheelMetrics 同一诚实约定）。
   */
  async getAuditReport(opts?: { eventsFile?: string; windowDays?: number }): Promise<AuditReport> {
    const windowDays = opts?.windowDays ?? 30;
    const timestamp = new Date().toISOString();

    // ── store 分区（恒有数据源） ──
    let entries: AuditReport['entries'] = { total: 0, byMaturity: {}, source: 'store' };
    let topReferenced: AuditReport['topReferenced'] = [];
    try {
      const all = this.store.list({});
      const byMaturity: Record<string, number> = {};
      for (const e of all) {
        const m = (e as any).maturity ?? 'unknown';
        byMaturity[m] = (byMaturity[m] || 0) + 1;
      }
      entries = { total: all.length, byMaturity, source: 'store' };
      topReferenced = all
        .map((e: any) => ({
          id: e.id,
          title: typeof e.title === 'string' ? e.title.slice(0, 80) : '',
          references: Array.isArray(e.referencedBy) ? e.referencedBy.length : 0,
        }))
        .filter(t => t.references > 0)
        .sort((a, b) => b.references - a.references)
        .slice(0, 5);
    } catch { /* store 读取失败 → 显式 0 */ }

    // ── 事件流分区 ──
    const stats = await scanKnowledgeEvents(opts);

    // trend：复用 outcome 成功率前后半窗口对比（与 getFlywheelMetrics.improvement 同一定义）
    let trend = 'insufficient-data';
    if (stats.outcomes.length > 0) {
      const now = Date.now();
      const windowStart = now - windowDays * 86400000;
      const midpoint = windowStart + (now - windowStart) / 2;
      const firstHalf = stats.outcomes.filter(o => o.ts < midpoint);
      const secondHalf = stats.outcomes.filter(o => o.ts >= midpoint);
      if (firstHalf.length > 0 && secondHalf.length > 0) {
        const sr1 = firstHalf.filter(o => o.success).length / firstHalf.length;
        const sr2 = secondHalf.filter(o => o.success).length / secondHalf.length;
        trend = sr2 > sr1 ? 'improving' : sr2 < sr1 ? 'declining' : 'stable';
      } else {
        trend = 'stable'; // 单边窗口无法比势，记 stable（有事件但趋势不可算）
      }
    }

    // ── findings：从实算数据派生，不预造 ──
    const findings: AuditFinding[] = [];
    if (entries.total === 0) {
      findings.push({ type: 'empty-store', severity: 'medium', description: '知识库无任何条目' });
    }
    const drafts = entries.byMaturity['draft'] ?? 0;
    if (drafts > 0) {
      findings.push({
        type: 'proposals-pending-review', severity: 'low',
        description: `${drafts} 条 proposal 待人工审核（maturity=draft，审核 promote 前不参与注入）`,
      });
    }
    if (stats.eventCounts.source === 'insufficient-data') {
      findings.push({
        type: 'no-events', severity: 'low',
        description: `近 ${windowDays} 天无 consumption/outcome/extraction 事件，飞轮尚无运行数据`,
      });
    }
    if (stats.eventCounts.outcomeFailure > stats.eventCounts.outcomeSuccess && stats.eventCounts.outcomeFailure > 0) {
      findings.push({
        type: 'failures-exceed-successes', severity: 'high',
        description: `窗口内失败 outcome (${stats.eventCounts.outcomeFailure}) 多于成功 (${stats.eventCounts.outcomeSuccess})`,
      });
    }

    return {
      findings,
      trend,
      timestamp,
      eventCounts: stats.eventCounts,
      entries,
      topReferenced,
      extractionActivity: stats.extractionActivity,
    };
  }

  /**
   * M1 诚实实现：系统中不存在 analyst 预测 vs 实际结果的结构化数据源。
   * recordAnalystAccuracy() 把数据写成 data/trends/ 的 markdown 文本，且生产代码无任何调用方
   * （仅 @deprecated KnowledgeBus 壳与测试引用）——没有可计算的输入，返回不可用标记而非假空 stub。
   */
  async getAnalystAccuracy(): Promise<AccuracyReport> {
    return {
      available: false,
      reason: '系统中不存在 analyst 预测 vs 实际结果的数据源（recordAnalystAccuracy 生产无调用方，预测/结果未结构化落盘），指标不可用而非编造',
      timestamp: new Date().toISOString(),
    };
  }

  // ═══════════ Additional methods (absorbed from KnowledgeBus / ResolutionService) ════════════

  /**
   * 知识统计概览 — absorbed from KnowledgeBus.getStats()
   */
  getStats(): Record<string, number> {
    try {
      const entries = this.store.list({});
      const byType: Record<string, number> = {};
      for (const e of entries) {
        const cat = (e as any).tags?.[0] || 'other';
        byType[cat] = (byType[cat] || 0) + 1;
      }
      byType.total = entries.length;
      return byType;
    } catch {
      return { total: 0 };
    }
  }

  /**
   * 验证 Resolution — verifyCount++，累积 3 次 → canonical
   * Absorbed from ResolutionService.verifyResolution()
   */
  async verifyResolution(id: string): Promise<void> {
    try {
      const row = await fileStore.readJson<any>(path.join(RESOLUTIONS_DIR, `${id}.json`));
      if (!row) return;

      const newCount = (row.verifyCount || 0) + 1;
      const newStatus = newCount >= 3 ? 'canonical' : (newCount >= 1 ? 'verified' : 'pending');

      const updated = {
        ...row,
        verifyCount: newCount,
        status: newStatus,
        lastVerifiedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await fileStore.writeJson(path.join(RESOLUTIONS_DIR, `${id}.json`), updated);
    } catch {
      // best-effort
    }
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
