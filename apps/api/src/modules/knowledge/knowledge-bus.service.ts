/**
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

import { KnowledgeStore, KnowledgeIngest, KnowledgeLifecycle, KnowledgeQuery, KnowledgeInjector } from '@dommaker/harness';
import type { KnowledgeType } from '@dommaker/harness';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { exec } from 'child_process';
import * as path from 'path';
import * as os from 'os';

// KE-002 P0: unified absolute path for knowledge storage
export const UNIFIED_KNOWLEDGE_DIR = path.join(os.homedir(), '.studio', 'knowledge');

// local-rag vector-db paths (must match MCP server config)
const LANCE_DB_PATH = path.join(os.homedir(), '.cache', 'mcp-local-rag', 'lancedb');
const MODEL_CACHE_DIR = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
const MODEL_NAME = path.join(MODEL_CACHE_DIR, 'models--onnx-community--bge-small-zh-v1.5-ONNX', 'snapshots', 'main');

// BusEntry type → KnowledgeType 保真映射 (KE-002 P1)
const BUS_ENTRY_TO_KNOWLEDGE_TYPE: Record<BusEntry['type'], KnowledgeType> = {
  pattern: 'guideline',
  failure: 'pitfall',
  incident: 'pitfall',
  pitfall: 'pitfall',
  guideline: 'guideline',
  trend: 'process',
  fix: 'guideline',
  analyst_accuracy: 'model',
};

// Singleton store + lifecycle + ingest — shared by knowledgeBus and knowledgeQuery
export const sharedStore = new KnowledgeStore({ baseDir: UNIFIED_KNOWLEDGE_DIR });
export const sharedLifecycle = new KnowledgeLifecycle(sharedStore, {
  autoPromoteSources: ['triage', 'auditor', 'evolution', 'posteval', 'analyst'],
});
export const sharedIngest = new KnowledgeIngest(sharedStore);
// KE-002 P3: budget-aware query + injector (replaces naive store.list)
export const sharedQuery = new KnowledgeQuery(sharedStore, sharedLifecycle);
export const sharedInjector = new KnowledgeInjector(sharedQuery);

// ── 统一条目类型 ──

export type KnowledgeSource =
  | 'monitor' | 'auditor' | 'ops' | 'kk' | 'triage'
  | 'executor' | 'reviewer' | 'analyst' | 'evolution'
  | 'deploy' | 'posteval'
  | 'session-summary';

export interface BusEntry {
  source: KnowledgeSource;
  type: 'pattern' | 'failure' | 'incident' | 'pitfall' | 'guideline' | 'trend' | 'fix' | 'analyst_accuracy';
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
      const maturity = sharedLifecycle.shouldAutoPromote(source) ? 'verified' as const : 'draft' as const;
      const result = this.ingest.ingestEntry(
        {
          type: BUS_ENTRY_TO_KNOWLEDGE_TYPE[entry.type] || 'guideline',
          title: entry.title,
          content: entry.content,
          tags: [entry.type],
        },
        {
          source: `pattern:${source}`,
          layer: 'project',
          maturity,
          tags: [entry.type],
        },
      );
      scheduleVectorDbSync();
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
          maturity: 'draft',
          tags: ['incident', entry.severity],
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
          maturity: sharedLifecycle.shouldAutoPromote('auditor') ? 'verified' : 'draft',
          tags: ['trend'],
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

  // ── Read ──

  /** 加载最近的相关知识（供 Agent 注入 prompt）+ 记录引用 */
  getRecentContext(agentType: string, maxItems = 10): string {
    try {
      const all = this.store.list({});
      if (all.length === 0) return '';

      // B13-007: maturity 加权排序
      const MATURITY_WEIGHT: Record<string, number> = { proven: 3, verified: 2, draft: 1 };
      const recent = all
        .filter(e => e.maturity !== 'archived')
        .sort((a, b) => {
          const wa = MATURITY_WEIGHT[a.maturity] || 1;
          const wb = MATURITY_WEIGHT[b.maturity] || 1;
          if (wa !== wb) return wb - wa;
          return (b.lastReferenced || '').localeCompare(a.lastReferenced || '');
        })
        .slice(0, maxItems);

      if (recent.length === 0) return '';

      // Record reference for each returned entry (closes the read→reference→promote circuit)
      for (const e of recent) {
        try {
          sharedLifecycle.recordReference(e.id, agentType);
        } catch { /* non-blocking */ }
      }

      const lines = ['\n## 历史积累（知识总线）'];
      lines.push('（引用知识条目时请标注 ID，如 [REF:pattern-xxx]）');
      for (const e of recent) {
        const icon = e.type === 'pitfall' ? '⚠️' : '📋';
        const source = e.contributors?.[0] || '?';
        lines.push(`- [REF:${e.id}] [${source}] ${icon} ${e.title}: ${e.content.slice(0, 200)}`);
      }
      return lines.join('\n');
    } catch (e: any) {
      logger.warn('[KnowledgeBus] Failed to load context', { error: String(e) });
      return '';
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

  /**
   * 知识索引摘要 — 告知 agent 有哪些知识可用及如何检索
   * 同时注入最近 5 条知识条目 + recordReference（闭合消费→成熟度回路）
   */
  formatIndexSummary(): string {
    try {
      const stats = this.getStats();
      const total = stats.total || 0;
      if (total === 0) return '';

      const typeLabels: Record<string, string> = {
        pattern: '代码模式、实现方案',
        pitfall: '已知坑点、常见错误',
        guideline: '编码规范、最佳实践',
        fix: '已验证的修复方案',
        trend: '趋势分析、性能数据',
      };

      const lines = [`你有 ${total} 条团队知识可用，类型分布：`];
      for (const [type, label] of Object.entries(typeLabels)) {
        const count = stats[type] || 0;
        if (count > 0) lines.push(`- ${type}: ${count} 条（${label}）`);
      }
      const otherCount = total - Object.keys(typeLabels).reduce((sum, t) => sum + (stats[t] || 0), 0);
      if (otherCount > 0) lines.push(`- 其他: ${otherCount} 条`);

      // B13-004: 注入最近条目 + recordReference（吸收 getRecentContext 闭环设计）
      // B13-007: maturity 加权排序（proven > verified > draft）
      try {
        const MATURITY_WEIGHT: Record<string, number> = { proven: 3, verified: 2, draft: 1 };
        const recent = this.store.list({ excludeArchived: true })
          .sort((a, b) => {
            const wa = MATURITY_WEIGHT[a.maturity] || 1;
            const wb = MATURITY_WEIGHT[b.maturity] || 1;
            if (wa !== wb) return wb - wa; // higher maturity first
            return (b.lastReferenced || '').localeCompare(a.lastReferenced || ''); // then by recency
          })
          .slice(0, 5);

        if (recent.length > 0) {
          lines.push('', '### 最近知识条目（引用时标注 ID）');
          for (const e of recent) {
            const icon = e.type === 'pitfall' ? '!' : '-';
            lines.push(`- [REF:${e.id}] ${icon} ${e.title}: ${e.content.slice(0, 100)}`);
            // 闭合消费→成熟度回路
            try { sharedLifecycle.recordReference(e.id, 'prompt-inject'); } catch { /* non-blocking */ }
          }
          logger.info('[KnowledgeBus] Knowledge injected into prompt', { count: recent.length, ids: recent.map(e => e.id) });
        }
      } catch { /* non-blocking — entry injection is best-effort */ }

      lines.push(
        '',
        '需要更多知识时，使用 mcp__local-rag__query_documents 工具检索。',
        '示例：遇到部署错误时 → query_documents("deploy timeout mergeBranches")',
        '不要猜测，先检索再行动。',
      );
      return lines.join('\n');
    } catch {
      return '';
    }
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
 * 失败重试：指数退避（10s, 20s, 40s... 最多 5 次）。
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
    const cmd = `mcp-local-rag --db-path ${LANCE_DB_PATH} --cache-dir ${MODEL_CACHE_DIR} --model-name ${MODEL_NAME} ingest "${UNIFIED_KNOWLEDGE_DIR}" --base-dir "${UNIFIED_KNOWLEDGE_DIR}"`;
    exec(cmd, { timeout: 300_000 }, (err, stdout, stderr) => {
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
        // #3: re-schedule with exponential backoff on real failure
        failCount++;
        if (failCount <= 5) {
          const backoffSec = Math.min(10 * Math.pow(2, failCount - 1), 120);
          logger.warn('[KnowledgeBus] vector-db sync failed, retrying', {
            attempt: failCount, backoffSec, error: msg.slice(0, 200),
          });
          setTimeout(() => scheduleVectorDbSync(), backoffSec * 1000);
        } else {
          logger.warn('[KnowledgeBus] vector-db sync failed permanently (giving up)', {
            attempts: failCount, error: msg.slice(0, 200), stderr: stderr?.slice(0, 200),
          });
          failCount = 0;  // reset for next trigger
        }
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
  scope: string;          // 子系统命名空间，如 "pipeline-logging", "knowledge-circuit"
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
