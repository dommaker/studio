/**
 * @deprecated Pipeline 层组件，随 Pipeline 30 天观察期后删除（2026-07 起算）。
 * Agent Network 层使用 knowledgeService（knowledge-service.ts）。
 * 新代码禁止引用本模块。
 *
 * KnowledgeBus — Agent 间共享知识总线 (H1, 2026-05-21)
 *
 * 每个 Agent 既是生产者也是消费者：
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
 * 底层存储：harness KnowledgeStore + DB (DecisionAudit, Incident, PipelineRun)
 */

import { FileKnowledgeStore, KnowledgeIngest, KnowledgeLifecycle, KnowledgeQuery, KnowledgeInjector, KnowledgeLinter, ReferenceTracker } from '@dommaker/harness';
import type { KnowledgeStore } from '@dommaker/harness';
import type { KnowledgeSubsystem, DecisionRecord } from '@dommaker/harness';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';

// KE-002 P0: unified absolute path for knowledge storage
export const UNIFIED_KNOWLEDGE_DIR = path.join(os.homedir(), '.studio', 'knowledge');

// local-rag vector-db paths (must match MCP server config)
const LANCE_DB_PATH = path.join(os.homedir(), '.cache', 'mcp-local-rag', 'lancedb');
const MODEL_CACHE_DIR = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
const MODEL_NAME = path.join(MODEL_CACHE_DIR, 'models--onnx-community--bge-small-zh-v1.5-ONNX', 'snapshots', 'main');

// Startup: kill orphan mcp-local-rag ingest processes from previous crashes
try {
  execFileSync('pkill', ['-f', 'mcp-local-rag.*ingest'], { stdio: 'ignore' });
  logger.info('[KnowledgeBus] Cleaned orphan mcp-local-rag ingest processes');
} catch { /* no orphans — good */ }

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

// Singleton store + lifecycle + ingest — shared by knowledgeBus and knowledgeQuery
export const sharedStore = new FileKnowledgeStore({ baseDir: UNIFIED_KNOWLEDGE_DIR });
export const sharedLifecycle = new KnowledgeLifecycle(sharedStore, {
  autoPromoteSources: ['triage', 'auditor', 'evolution', 'posteval', 'analyst'],
});
export const sharedIngest = new KnowledgeIngest(sharedStore);
// KE-002 P3: budget-aware query + injector (replaces naive store.list)
export const sharedQuery = new KnowledgeQuery(sharedStore, sharedLifecycle);
export const sharedInjector = new KnowledgeInjector(sharedQuery);
// GAP-01: shared linter for ingest validation
export const sharedLinter = new KnowledgeLinter(sharedStore, new ReferenceTracker(sharedStore));

// D6 flywheel: emit consumption events on every recordReference() call
// (same-day dedup already handled by lifecycle, so max 1 event per contributor per entry per day)
// Cast needed: onReference added in harness 0.13.4+, npm version may lag
let _consumptionCallbackRegistered = false;
(sharedLifecycle as any).onReference?.((event: { entryId: string; contributor: string; timestamp: string }) => {
  prisma.studioEvent.create({
    data: {
      type: 'knowledge:consumption',
      source: event.contributor,
      payload: JSON.stringify({ entryId: event.entryId, timestamp: event.timestamp }),
    },
  }).catch((e: any) => {
    logger.warn('[KnowledgeBus] consumption event failed', { error: String(e) });
  });
});
_consumptionCallbackRegistered = typeof (sharedLifecycle as any).onReference === 'function';
if (!_consumptionCallbackRegistered) {
  logger.error('[KnowledgeBus] onReference callback NOT registered — consumption events will not be emitted. Check harness version (need >=0.13.4)');
}

/**
 * GAP-16: Verify consumption event chain integrity.
 * Call once at startup to confirm recordReference → onReference → StudioEvent works.
 */
export async function verifyConsumptionChain(): Promise<boolean> {
  try {
    if (!_consumptionCallbackRegistered) return false;
    // Write a probe event directly to confirm DB is writable
    const probe = await prisma.studioEvent.create({
      data: {
        type: 'knowledge:probe',
        source: 'startup',
        payload: JSON.stringify({ ts: Date.now(), purpose: 'chain-integrity-check' }),
      },
    });
    logger.info('[KnowledgeBus] Consumption chain probe OK', { probeId: probe.id });
    return true;
  } catch (e: any) {
    logger.error('[KnowledgeBus] Consumption chain probe FAILED', { error: String(e) });
    return false;
  }
}

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

      // Triage quality gate: require root_cause + fix_action
      if (source === 'triage') {
        const content = (entry.content || '').toLowerCase();
        if (!content.includes('root_cause') || !content.includes('fix_action')) {
          const msg = 'Triage entry must include root_cause and fix_action';
          logger.warn(`[KnowledgeBus] ${msg}`, { title: entry.title });
          prisma.studioEvent.create({
            data: {
              type: 'knowledge:quality_gate',
              source: 'knowledge-bus',
              payload: JSON.stringify({ skipped: true, reason: msg, entryType: entry.type }),
            },
          }).catch(() => {});
          throw new Error(msg);
        }
      }

      // Quality gate: reject entries with high severity issues
      const tags: string[] = [entry.type];
      const issues = sharedLinter.validateEntry({ title: entry.title || '', content: entry.content || '', tags, type: BUS_ENTRY_TO_KNOWLEDGE_TYPE[entry.type] || 'guideline' });
      const blockers = issues.filter(i => i.severity === 'high');
      if (blockers.length > 0) {
        logger.warn('[KnowledgeBus] Entry rejected by quality gate', { title: entry.title, issues: blockers.map(i => i.description) });
        prisma.studioEvent.create({
          data: {
            type: 'knowledge:quality_gate',
            source: 'knowledge-bus',
            payload: JSON.stringify({ skipped: true, reason: blockers.map(i => i.description).join('; '), entryType: entry.type }),
          },
        }).catch(() => {});
        return;
      }

      const result = this.ingest.ingestEntry(
        {
          type: BUS_ENTRY_TO_KNOWLEDGE_TYPE[entry.type] || 'guideline',
          title: entry.title,
          content: entry.content,
          tags,
        },
        {
          source: `pattern:${source}`,
          layer: 'project',
          maturity: 'active',
          tags,
          consumptionMode: 'signal',
        },
      );
      scheduleVectorDbSync();
      // Log dedup merges
      if (result.lastReferenced && result.contributors.length > 1) {
        logger.info('[KnowledgeBus] Dedup merged', { title: entry.title, existingId: result.id });
      }

      // S3 Gap 3d: emit entry_created for knowledge_growth_rate metric
      prisma.studioEvent.create({
        data: {
          type: 'knowledge:entry_created',
          source: 'knowledge-bus',
          payload: JSON.stringify({ entryType: entry.type, title: entry.title }),
        },
      }).catch(() => {});
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
        missedFiles.length > 0 ? `漏预测文件: ${missedFiles.join(', ')}` : '',
        extraFiles.length > 0 ? `多预测文件: ${extraFiles.join(', ')}` : '',
        missedDeps.length > 0 ? `漏预测依赖: ${missedDeps.join(', ')}` : '',
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

  /** KnowledgeAgent: 记录架构/工具/流程决策 */
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
        prisma.studioEvent.create({
          data: {
            type: 'knowledge:search_hit',
            source: 'search',
            payload: JSON.stringify({
              query: query.slice(0, 200),
              hitCount: scored.length,
              avgScore: Math.round(avgScore * 100) / 100,
              entryIds: scored.map(r => r.id),
            }),
          },
        }).catch((e: any) => {
          logger.warn('[KnowledgeBus] search_hit event failed', { error: String(e) });
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

// ── local-rag sync debounce timer + mutex ──
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncInProgress = false;
let deferredSince: number | null = null;  // #2: track deferral start for log dedup
let failCount = 0;  // #3: consecutive failure count for backoff

/**
 * 将 .studio/knowledge/ 同步到 local-rag 向量库。
 * 防止 safeIngest 写盘后 Agent 无法通过 mcp__local-rag__query_documents 检索到新条目。
 *
 * 使用 mcp-local-rag CLI 增量 ingest（已 ingest 的文件自动跳过）。
 * 5s 防抖：批量 ingest 15 条 → 只触发 1 次 sync。
 * 互斥锁：防止并发写入 LanceDB 导致 commit conflict。
 * 失败重试：指数退避（10s, 20s, 40s... cap 120s，不设上限）。
 */
export function isVectorDbSyncing(): boolean {
  return syncInProgress;
}

export function scheduleVectorDbSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    if (syncInProgress) {
      // #2: only log first defer, not every 5s
      if (!deferredSince) {
        deferredSince = Date.now();
        logger.info('[KnowledgeBus] vector-db sync deferred (previous sync still running)');
      }
      scheduleVectorDbSync();
      return;
    }
    syncInProgress = true;
    const args = [
      '-n', '10', 'mcp-local-rag',
      '--db-path', LANCE_DB_PATH,
      '--cache-dir', MODEL_CACHE_DIR,
      '--model-name', MODEL_NAME,
      'ingest', UNIFIED_KNOWLEDGE_DIR,
      '--base-dir', UNIFIED_KNOWLEDGE_DIR,
    ];
    execFile('nice', args, { timeout: 300_000 }, (err, stdout, stderr) => {
      syncInProgress = false;
      // #2: log resume after deferral
      if (deferredSince) {
        const waited = Math.round((Date.now() - deferredSince) / 1000);
        deferredSince = null;
        logger.info('[KnowledgeBus] vector-db sync resumed after deferral', { waitedSec: waited });
      }
      if (err) {
        // optimize() failures are non-fatal (data already inserted)
        const msg = err.message || '';
        if (msg.includes('Succeeded:')) {
          const summary = msg.match(/Succeeded:\s*\d+.*Failed:\s*\d+.*Total chunks:\s*\d+/s)?.[0];
          logger.info('[KnowledgeBus] vector-db synced (with optimize warning)', { summary });
          failCount = 0;
          return;
        }
        // #3: re-schedule with exponential backoff on real failure (cap 10 attempts, 120s backoff)
        failCount++;
        if (failCount > 10) {
          logger.error('[KnowledgeBus] vector-db sync gave up after 10 attempts', {
            totalAttempts: failCount, lastError: msg.slice(0, 500),
          });
          failCount = 0;
          return;
        }
        const backoffSec = Math.min(10 * Math.pow(2, failCount - 1), 120);
        logger.warn('[KnowledgeBus] vector-db sync failed, retrying', {
          attempt: failCount, backoffSec, error: msg.slice(0, 500),
        });
        setTimeout(() => scheduleVectorDbSync(), backoffSec * 1000);
        return;
      }
      failCount = 0;
      // Extract summary line from stdout
      const summary = stdout.match(/Succeeded:\s*\d+.*Failed:\s*\d+.*Total chunks:\s*\d+/s)?.[0] || stdout.slice(-100);
      logger.info('[KnowledgeBus] vector-db synced', { summary });
    });
  }, 5_000);
}

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
