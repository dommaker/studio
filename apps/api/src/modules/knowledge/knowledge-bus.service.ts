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

import { KnowledgeStore } from '@dommaker/harness';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

// ── 统一条目类型 ──

export type KnowledgeSource =
  | 'monitor' | 'auditor' | 'ops' | 'kk' | 'triage'
  | 'executor' | 'reviewer' | 'analyst' | 'evolution';

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

  constructor() {
    this.store = new KnowledgeStore();
  }

  // ── Write ──

  /** Monitor: 记录 Agent 执行失败模式 */
  async recordPattern(entry: Omit<BusEntry, 'source'> & { source?: KnowledgeSource }): Promise<void> {
    try {
      this.store.save({
        id: `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'guideline',
        title: entry.title,
        content: entry.content,
        maturity: 'draft',
        layer: 'project',
        created: new Date().toISOString(),
        lastReferenced: new Date().toISOString(),
        contributors: [entry.source || 'monitor'],
        projects: [],
        tags: [entry.type],
        applicablePhases: [],
        sourceReferences: [],
        referencedBy: [],
      });
    } catch (e: any) {
      logger.warn('[KnowledgeBus] Failed to record pattern', { error: String(e) });
    }
  }

  /** Ops: 记录故障 */
  async recordIncident(entry: BusEntry): Promise<void> {
    try {
      this.store.save({
        id: `incident-${entry.title.slice(0, 30).replace(/\s+/g, '-')}-${Date.now()}`,
        type: 'pitfall',
        title: entry.title,
        content: entry.content,
        maturity: 'draft',
        layer: 'tech',
        created: new Date(entry.timestamp).toISOString(),
        lastReferenced: new Date().toISOString(),
        contributors: ['ops'],
        projects: [],
        tags: ['incident', entry.severity],
        applicablePhases: [],
        sourceReferences: [],
        referencedBy: [],
      });
    } catch (e: any) {
      logger.warn('[KnowledgeBus] Failed to record incident', { error: String(e) });
    }
  }

  /** Auditor: 记录趋势 */
  async recordTrend(entry: BusEntry): Promise<void> {
    try {
      this.store.save({
        id: `trend-${Date.now()}`,
        type: 'guideline',
        title: entry.title,
        content: entry.content,
        maturity: 'verified',
        layer: 'project',
        created: new Date(entry.timestamp).toISOString(),
        lastReferenced: new Date().toISOString(),
        contributors: ['auditor'],
        projects: [],
        tags: ['trend'],
        applicablePhases: [],
        sourceReferences: [],
        referencedBy: [],
      });
    } catch (e: any) {
      logger.warn('[KnowledgeBus] Failed to record trend', { error: String(e) });
    }
  }

  // ── Read ──

  /** 加载最近的相关知识（供 Agent 注入 prompt） */
  getRecentContext(agentType: string, maxItems = 10): string {
    try {
      const all = this.store.list({});
      if (all.length === 0) return '';

      const recent = all
        .filter(e => e.maturity !== 'archived')
        .sort((a, b) => b.lastReferenced.localeCompare(a.lastReferenced))
        .slice(0, maxItems);

      if (recent.length === 0) return '';

      const lines = ['\n## 历史积累（知识总线）'];
      for (const e of recent) {
        const icon = e.type === 'pitfall' ? '⚠️' : '📋';
        const source = e.contributors?.[0] || '?';
        lines.push(`- [${source}] ${icon} ${e.title}: ${e.content.slice(0, 200)}`);
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
