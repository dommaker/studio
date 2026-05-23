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

import { KnowledgeStore, KnowledgeIngest, KnowledgeLifecycle } from '@dommaker/harness';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

// Singleton store + lifecycle + ingest — shared by knowledgeBus and knowledgeQuery
export const sharedStore = new KnowledgeStore();
export const sharedLifecycle = new KnowledgeLifecycle(sharedStore);
const sharedIngest = new KnowledgeIngest(sharedStore);

// ── 统一条目类型 ──

export type KnowledgeSource =
  | 'monitor' | 'auditor' | 'ops' | 'kk' | 'triage'
  | 'executor' | 'reviewer' | 'analyst' | 'evolution'
  | 'deploy' | 'posteval';

export interface BusEntry {
  source: KnowledgeSource;
  type: 'pattern' | 'failure' | 'incident' | 'pitfall' | 'guideline' | 'trend' | 'fix';
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
      // Triage fix + Auditor trend are battle-tested → start at verified
      const maturity = source === 'triage' || source === 'auditor' || source === 'evolution'
        ? 'verified' as const
        : 'draft' as const;
      const result = this.ingest.ingestEntry(
        {
          type: 'guideline',
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
          type: 'guideline',
          title: entry.title,
          content: entry.content,
          tags: ['trend'],
        },
        {
          source: `trend:auditor:${new Date(entry.timestamp).toISOString()}`,
          layer: 'project',
          maturity: 'verified',
          tags: ['trend'],
        },
      );
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

      const recent = all
        .filter(e => e.maturity !== 'archived')
        .sort((a, b) => b.lastReferenced.localeCompare(a.lastReferenced))
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

  /**
   * 查询特定类型的知识（供 Agent 检索）
   */
  async queryByType(type: string, limit = 10): Promise<BusEntry[]> {
    try {
      const entries = this.store.list({});
      return entries
        .filter(e => e.tags?.includes(type))
        .sort((a, b) => b.lastReferenced.localeCompare(a.lastReferenced))
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
    logger.info('[KnowledgeBus] Created design-entry', { scope, entryId: result.id, title });
    return { action: 'created', entryId: result.id };
  }

  // 有已有条目 → 对比内容
  const latest = existing.sort((a, b) => b.lastReferenced.localeCompare(a.lastReferenced))[0];
  const existingHash = Buffer.from(latest.content).toString('base64').slice(0, 32);

  if (contentHash !== existingHash) {
    // 内容变化 → 更新
    sharedLifecycle.recordReference(latest.id, source);
    const updated = sharedStore.update(latest.id, {
      content,
      title,
      maturity: 'verified',  // 重置为 verified，新一轮验证
    });
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
