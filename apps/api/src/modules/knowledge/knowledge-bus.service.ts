/**
 * KnowledgeBus — 兼容层（thin compat，R4 收敛后保留）
 *
 * TODO(R4-followup): KnowledgeBus 类的 write/search API 与 KnowledgeService 重复，
 * 消费者（knowledge-sync / knowledge-curator / routes）应逐步迁移到
 * knowledgeService，之后删除本类。新代码禁止直接使用 KnowledgeBus，请用 knowledgeService。
 *
 * 共享单例（sharedStore/sharedLifecycle/sharedIngest/sharedQuery/sharedInjector/
 * sharedLinter）、向量库同步（scheduleVectorDbSync）与消费链验证
 * （verifyConsumptionChain）已收敛至 knowledge-singletons.ts —— 本模块仅做 re-export。
 * recordPattern 质量门已统一：KnowledgeBus 与 knowledgeService 均经
 * ingestWithQualityGate（harness ingest 门）单一路径入库。
 *
 * 历史背景 — Agent 间共享知识总线 (H1, 2026-05-21)：
 *   Monitor → write pattern/failure
 *   Auditor → write tier stats/trend
 *   Ops     → write incident
 *   KK      → write pitfall/guideline/skill
 *   Triage  → write fix strategy
 *
 *   Analyst → read all before /plan
 *   Executor → read patterns before execution
 *   Ops     → read incidents for pattern learning
 *
 * 底层存储：harness KnowledgeStore + DB (Incident, PipelineRun)
 */

import { logger } from '@dommaker/studio-shared';
import type { KnowledgeStore, KnowledgeIngest } from '@dommaker/harness';
import type { KnowledgeSubsystem, DecisionRecord } from '@dommaker/harness';
import {
  sharedStore,
  sharedLifecycle,
  sharedIngest,
  scheduleVectorDbSync,
  ingestWithQualityGate,
  appendKnowledgeEvent,
} from './knowledge-singletons.js';

// ── Re-export：单例所有权在 knowledge-singletons.ts（兼容既有 import 路径） ──
export {
  UNIFIED_KNOWLEDGE_DIR,
  sharedStore,
  sharedLifecycle,
  sharedIngest,
  sharedQuery,
  sharedInjector,
  sharedLinter,
  verifyConsumptionChain,
  scheduleVectorDbSync,
  isVectorDbSyncing,
} from './knowledge-singletons.js';

// BusEntry type → KnowledgeType 保真映射 (KE-002 P1)
const BUS_ENTRY_TO_KNOWLEDGE_TYPE: Record<BusEntry['type'], KnowledgeSubsystem> = {
  pattern: 'guideline',
  failure: 'pitfall',
  incident: 'pitfall',
  pitfall: 'pitfall',
  guideline: 'guideline',
  trend: 'process',
  fix: 'guideline',
  analyst_accuracy: 'model',
  decision: 'decision',
};

// ── 统一条目类型 ──

export type KnowledgeSource =
  | 'monitor' | 'auditor' | 'ops' | 'kk' | 'triage'
  | 'executor' | 'reviewer' | 'analyst' | 'evolution'
  | 'deploy' | 'posteval'
  | 'session-summary';

export interface BusEntry {
  source: KnowledgeSource;
  type: 'pattern' | 'failure' | 'incident' | 'pitfall' | 'guideline' | 'trend' | 'fix' | 'analyst_accuracy' | 'decision';
  title: string;
  content: string;
  severity: 'info' | 'warning' | 'critical';
  timestamp: number;
  context?: Record<string, unknown>;
}

/**
 * @deprecated 兼容类 — 新代码请用 knowledgeService（knowledge-service.ts）。
 * write 路径质量门已与 knowledgeService.recordPattern 统一（ingestWithQualityGate）。
 */
export class KnowledgeBus {
  private store: KnowledgeStore;
  private ingest: KnowledgeIngest;

  constructor() {
    this.store = sharedStore;
    this.ingest = sharedIngest;
  }

  // ── Write ──

  /** Monitor: 记录 Agent 执行失败模式 */
  async recordPattern(entry: Omit<BusEntry, 'source'> & { source?: KnowledgeSource }): Promise<void> {
    try {
      const source = entry.source || 'monitor';

      const result = ingestWithQualityGate(
        { ingest: this.ingest },
        {
          type: BUS_ENTRY_TO_KNOWLEDGE_TYPE[entry.type] || 'guideline',
          title: entry.title,
          content: entry.content,
          tags: [entry.type],
          source,
          entryType: entry.type,
          layer: 'project',
          maturity: 'active',
          consumptionMode: 'signal',
        },
      );
      if (!result) return; // 质量门跳过（事件已由门禁记录）

      // Log dedup merges
      if (result.lastReferenced && result.contributors.length > 1) {
        logger.info('[KnowledgeBus] Dedup merged', { title: entry.title, existingId: result.id });
      }
    } catch (e: any) {
      logger.warn('[KnowledgeBus] Failed to record pattern', { error: String(e) });
    }
  }

  /** Ops: 记录故障 */
  async recordIncident(entry: BusEntry): Promise<void> {
    try {
      const result = this.ingest.ingestEntry(
        {
          type: 'pitfall',
          title: entry.title,
          content: entry.content,
          tags: ['incident', entry.severity],
        },
        {
          source: `incident:ops:${new Date(entry.timestamp).toISOString()}`,
          layer: 'tech',
          maturity: 'active',
          tags: ['incident', entry.severity],
          consumptionMode: 'signal',
        },
      );
      scheduleVectorDbSync();
      if (result.lastReferenced && result.contributors.length > 1) {
        logger.info('[KnowledgeBus] Dedup merged (incident)', { title: entry.title, existingId: result.id });
      }
    } catch (e: any) {
      logger.warn('[KnowledgeBus] Failed to record incident', { error: String(e) });
    }
  }

  /** Auditor: 记录趋势 */
  async recordTrend(entry: BusEntry): Promise<void> {
    try {
      const result = this.ingest.ingestEntry(
        {
          type: BUS_ENTRY_TO_KNOWLEDGE_TYPE[entry.type] || 'process',
          title: entry.title,
          content: entry.content,
          tags: ['trend'],
        },
        {
          source: `trend:auditor:${new Date(entry.timestamp).toISOString()}`,
          layer: 'project',
          maturity: 'active',
          tags: ['trend'],
          consumptionMode: 'signal',
        },
      );
      scheduleVectorDbSync();
      if (result.lastReferenced && result.contributors.length > 1) {
        logger.info('[KnowledgeBus] Dedup merged (trend)', { title: entry.title, existingId: result.id });
      }
    } catch (e: any) {
      logger.warn('[KnowledgeBus] Failed to record trend', { error: String(e) });
    }
  }

  // ── Analyst Accuracy Feedback Loop ──

  /** PostEval 记录 Analyst 预测准确率，供下次 Analyst 运行时注入 */
  async recordAnalystAccuracy(data: {
    docId: string;
    goalTitle: string;
    predictedFiles: string[];
    actualFiles: string[];
    predictedDeps: string[];
    actualDeps: string[];
    acMatchRate: number;
    missesByType: Record<string, number>;
  }): Promise<void> {
    try {
      const missedFiles = data.predictedFiles.filter(f => !data.actualFiles.includes(f));
      const extraFiles = data.actualFiles.filter(f => !data.predictedFiles.includes(f));
      const missedDeps = data.predictedDeps.filter(d => !data.actualDeps.includes(d));

      const content = [
        `任务: ${data.goalTitle}`,
        `AC匹配率: ${Math.round(data.acMatchRate * 100)}%`,
        `预测文件: [${data.predictedFiles.join(', ')}]`,
        `实际文件: [${data.actualFiles.join(', ')}]`,
        missedFiles.length > 0 ? `漏预测文件: [${missedFiles.join(', ')}]` : '',
        extraFiles.length > 0 ? `多预测文件: [${extraFiles.join(', ')}]` : '',
        missedDeps.length > 0 ? `漏预测依赖: [${missedDeps.join(', ')}]` : '',
        Object.entries(data.missesByType).length > 0
          ? `误判类型: ${Object.entries(data.missesByType).map(([k, v]) => `${k}(${v})`).join(', ')}`
          : '',
      ].filter(Boolean).join('; ');

      const result = this.ingest.ingestEntry(
        {
          type: BUS_ENTRY_TO_KNOWLEDGE_TYPE['analyst_accuracy'],
          title: `AnalystAccuracy: ${data.goalTitle.slice(0, 80)}`,
          content,
          tags: ['analyst_accuracy'],
        },
        {
          source: `analyst_accuracy:posteval:${data.docId.slice(0, 16)}`,
          layer: 'project',
          maturity: sharedLifecycle.shouldAutoPromote('posteval') ? 'verified' : 'draft',
          tags: ['analyst_accuracy'],
        },
      );
      scheduleVectorDbSync();
      if (result.lastReferenced && result.contributors.length > 1) {
        logger.info('[KnowledgeBus] Analyst accuracy dedup merged', {
          docId: data.docId.slice(0, 16),
          existingId: result.id,
        });
      }
    } catch (e: any) {
      logger.warn('[KnowledgeBus] Failed to record analyst accuracy', { error: String(e) });
    }
  }

  /** KnowledgeCurator: 记录架构/工具/流程决策 */
  async recordDecision(entry: DecisionRecord): Promise<void> {
    try {
      const title = `${entry.topic}: ${entry.decision}`;
      const content = [
        entry.context && `上下文: ${entry.context}`,
        entry.decision && `决策: ${entry.decision}`,
        entry.rationale && `理由: ${entry.rationale}`,
        entry.consequences && `权衡: ${entry.consequences}`,
        entry.alternatives?.length > 0 && `备选: ${entry.alternatives.join(' / ')}`,
      ].filter(Boolean).join('\n');
      const tags = ['decision', entry.category];
      const result = this.ingest.ingestEntry(
        { type: 'decision', title, content, tags },
        { source: `decision:${entry.sourceType}:${entry.sourceId || 'unknown'}`, layer: 'project', maturity: 'active', tags, consumptionMode: 'reference' },
      );
      scheduleVectorDbSync();
      if (result.lastReferenced && result.contributors.length > 1) {
        logger.info('[KnowledgeBus] Dedup merged (decision)', { title, existingId: result.id });
      }
    } catch (e: any) {
      logger.warn('[KnowledgeBus] Failed to record decision', { error: String(e) });
    }
  }

  /**
   * 查询特定类型的知识（供 Agent 检索）
   */
  async queryByType(type: string, limit = 10): Promise<BusEntry[]> {
    try {
      const entries = this.store.list({});
      return entries
        .filter(e => e.tags?.includes(type))
        .sort((a, b) => (b.lastReferenced || '').localeCompare(a.lastReferenced || ''))
        .slice(0, limit)
        .map(e => ({
          source: (e.contributors?.[0] || 'unknown') as KnowledgeSource,
          type: (e.tags?.[0] || 'pattern') as BusEntry['type'],
          title: e.title,
          content: e.content,
          severity: (e.tags?.includes('critical') ? 'critical' : 'info') as BusEntry['severity'],
          timestamp: new Date(e.lastReferenced).getTime(),
          context: { id: e.id, maturity: e.maturity },
        }));
    } catch (e: any) {
      logger.warn('[KnowledgeBus] Query failed', { error: String(e) });
      return [];
    }
  }

  /**
   * 知识统计概览
   */
  getStats(): Record<string, number> {
    try {
      const entries = this.store.list({});
      const byType: Record<string, number> = {};
      for (const e of entries) {
        const cat = e.tags?.[0] || 'other';
        byType[cat] = (byType[cat] || 0) + 1;
      }
      byType['total'] = entries.length;
      return byType;
    } catch {
      return { total: 0 };
    }
  }

  // ── AS-019: Keyword Search ──

  private static readonly STOP_WORDS = new Set([
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

  private static readonly TYPE_WEIGHT: Record<string, number> = {
    pitfall: 3, pattern: 2, guideline: 2, fix: 2,
    process: 1, analysis: 1, trend: 1,
  };

  /** Extract keywords from prompt text (zero token cost) */
  static extractKeywords(prompt: string): string[] {
    return prompt
      .toLowerCase()
      .split(/[\s,，。！？、；：""''（）\(\)\[\]{}<>\/\\|@#$%^&*+=~`!\-_]+/)
      .filter(w => w.length >= 2 && !KnowledgeBus.STOP_WORDS.has(w))
      .slice(0, 8);
  }

  /** Search knowledge entries by keyword relevance */
  search(query: string, opts?: { limit?: number; type?: string }): Array<{
    id: string; type: string; title: string; content: string;
    maturity: string; score: number; matchContext: string;
  }> {
    try {
      const limit = opts?.limit || 5;
      const all = this.store.list({});
      if (all.length === 0) return [];

      const keywords = KnowledgeBus.extractKeywords(query);
      if (keywords.length === 0) return [];

      const now = Date.now();
      const scored = all
        .filter(e => e.maturity !== 'archived')
        .filter(e => !opts?.type || e.tags?.includes(opts.type))
        .map(e => {
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

          const typeWeight = KnowledgeBus.TYPE_WEIGHT[e.tags?.[0] || ''] || 1;
          const daysAgo = e.lastReferenced
            ? (now - new Date(e.lastReferenced).getTime()) / 86400000
            : 30;
          const freshness = daysAgo < 7 ? 1.0 : Math.max(0.2, 1 - (daysAgo - 7) / 30);
          const maturityWeight = { proven: 1.5, verified: 1.0, draft: 0.5 }[e.maturity] || 0.5;
          // GAP-08: deprioritize low_quality entries
          const qualityPenalty = e.tags?.includes('low_quality') ? 0.3 : 1.0;

          const score = keywordScore * typeWeight * freshness * maturityWeight * qualityPenalty;
          // Extract match context: snippet around first keyword match
          const matchContext = bestMatchPos >= 0
            ? e.content.slice(Math.max(0, bestMatchPos - 40), bestMatchPos + 160)
            : e.content.slice(0, 200);

          return {
            id: e.id, type: e.tags?.[0] || 'pattern', title: e.title,
            content: e.content, maturity: e.maturity, score, matchContext,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      // Record references for returned entries
      for (const r of scored) {
        try { sharedLifecycle.recordReference(r.id, 'search'); } catch { /* non-blocking */ }
      }

      // D6 flywheel: record search hit rate with scores
      if (scored.length > 0) {
        const avgScore = scored.reduce((s, r) => s + r.score, 0) / scored.length;
        appendKnowledgeEvent('knowledge:search_hit', {
          query: query.slice(0, 200),
          hitCount: scored.length,
          avgScore: Math.round(avgScore * 100) / 100,
          entryIds: scored.map(r => r.id),
        });
      }

      return scored;
    } catch (e) {
      logger.warn('[KnowledgeBus] search failed', { error: String(e) });
      return [];
    }
  }

  /** Format search results for prompt injection (match-context priority) */
  formatSearchForPrompt(results: ReturnType<typeof this.search>): string {
    if (results.length === 0) return '';
    const lines = ['\n## 历史相关知识（按需求匹配度排序）'];
    for (const r of results) {
      const icon = r.type === 'pitfall' ? '⚠️' : r.type === 'guideline' ? '📋' : '🔍';
      lines.push(`- [REF:${r.id}] ${icon} ${r.title}: ${r.matchContext}`);
    }
    return lines.join('\n');
  }
}

export const knowledgeBus = new KnowledgeBus();

/**
 * 设计时知识沉淀：按 scope 去重写入。
 * 对比已有条目 → 新增/更新/刷新 lastReferenced，防止重复和腐烂。
 *
 * 用于：管线分析、架构审计、电路自检逻辑等长分析文档的持久化。
 * 与 recordPattern() 的区别：recordPattern 是运行时事件 → prompt 注入；
 * upsertKnowledge 是设计分析结论 → 供 agent 查询（不进 prompt 注入流）。
 */
export async function upsertKnowledge(params: {
  scope: string;          // 子系统命名空间，如 "workunit-execution", "knowledge-circuit"
  title: string;
  content: string;
  type?: 'architecture' | 'process' | 'guideline';
  source?: KnowledgeSource;
}): Promise<{ action: 'created' | 'updated' | 'refreshed' | 'unchanged'; entryId: string }> {
  const { scope, title, content, type = 'architecture', source = 'analyst' } = params;
  const contentHash = Buffer.from(content).toString('base64').slice(0, 32);

  // 查找同 scope 的已有条目（design-doc tag + scope tag 双重匹配）
  const existing = sharedStore.list({ tags: ['design-doc'] }).filter(e => e.tags?.includes(scope) && e.type === type);

  if (existing.length === 0) {
    // 无已有条目 → 创建
    const result = sharedIngest.ingestEntry(
      { type: type as any, title, content, tags: [scope, 'design-doc'] },
      { source: `design:${source}:${scope}`, layer: 'tech', maturity: 'verified', tags: [scope, 'design-doc'] },
    );
    scheduleVectorDbSync();
    logger.info('[KnowledgeBus] Created design-entry', { scope, entryId: result.id, title });
    return { action: 'created', entryId: result.id };
  }

  // 有已有条目 → 对比内容
  const latest = existing.sort((a, b) => (b.lastReferenced || '').localeCompare(a.lastReferenced || ''))[0];
  const existingHash = Buffer.from(latest.content).toString('base64').slice(0, 32);

  if (contentHash !== existingHash) {
    // 内容变化 → 更新
    sharedLifecycle.recordReference(latest.id, source);
    const updated = sharedStore.update(latest.id, {
      content,
      title,
      maturity: 'verified',  // 重置为 verified，新一轮验证
    });
    scheduleVectorDbSync();
    logger.info('[KnowledgeBus] Updated design-entry (content changed)', { scope, entryId: latest.id });
    return { action: 'updated', entryId: latest.id };
  }

  // 内容一致 → 刷新 lastReferenced 防止衰减
  const lastRefAge = Date.now() - new Date(latest.lastReferenced || latest.created).getTime();
  if (lastRefAge > 6 * 60 * 60 * 1000) {
    // >6h 才刷新，避免高频写入
    sharedLifecycle.recordReference(latest.id, source);
    logger.info('[KnowledgeBus] Refreshed design-entry', { scope, entryId: latest.id });
    return { action: 'refreshed', entryId: latest.id };
  }

  return { action: 'unchanged', entryId: latest.id };
}

/**
 * 新鲜度检测：查找 scope-tagged 条目中被引用代码可能已变更的过期条目。
 * 原理：条目创建后，如果它关联的源码文件有新的 git commit → 可能过期。
 */
export function checkDocumentFreshness(repoDir?: string): Array<{
  entryId: string; scope: string; title: string; lastUpdated: string; staleSince?: string;
}> {
  const stale: Array<{ entryId: string; scope: string; title: string; lastUpdated: string; staleSince?: string }> = [];
  const designEntries = sharedStore.list({ tags: ['design-doc'] });

  if (designEntries.length === 0 || !repoDir) return stale;

  try {
    const { execSync } = require('child_process');
    const recentCommits = execSync('git log --since="7 days ago" --name-only --format="%H %ct"', {
      cwd: repoDir, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000,
    });

    for (const entry of designEntries) {
      // Entries untouched for >7 days AND referenced code has recent commits → potentially stale
      const ageDays = (Date.now() - new Date(entry.lastReferenced || entry.created).getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays < 7) continue;

      // Check if entry's scope matches any recently changed files
      const scopePattern = entry.tags?.find(t => t !== 'design-doc');
      if (!scopePattern) continue;

      const scopeRelated = recentCommits.includes(scopePattern.replace(/-/g, '/'));
      if (scopeRelated) {
        stale.push({
          entryId: entry.id, scope: scopePattern, title: entry.title,
          lastUpdated: entry.lastReferenced || entry.created,
          staleSince: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString(),
        });
      }
    }
  } catch { /* git unavailable — skip freshness check */ }

  return stale;
}
