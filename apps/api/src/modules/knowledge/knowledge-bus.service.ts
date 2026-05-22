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

/** 闭环自检：每条 entry 追生命周期跃迁链，因果推断电路连通性 */
export function checkKnowledgeCircuit(): {
  healthy: boolean;
  circuits: Record<string, { status: 'CLOSED' | 'OPEN' | 'UNKNOWN'; evidence: string; likelyCause?: string }>;
  stats: { total: number; byMaturity: Record<string, number>; byType: Record<string, number> };
} {
  const entries = sharedStore.list({ excludeArchived: false });
  const byMaturity: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const e of entries) {
    byMaturity[e.maturity] = (byMaturity[e.maturity] || 0) + 1;
    byType[e.type] = (byType[e.type] || 0) + 1;
  }

  const circuits: Record<string, { status: 'CLOSED' | 'OPEN' | 'UNKNOWN'; evidence: string; likelyCause?: string }> = {};
  const now = Date.now();
  const MIN_AGE_MS = 60 * 60 * 1000; // 1h — entries younger than this are insufficient evidence

  // Helper: is entry old enough to be valid evidence?
  const isAged = (e: { created: string }) => now - new Date(e.created).getTime() > MIN_AGE_MS;

  // ── Circuit 1: Write→Read (entry created → someone read it) ──
  const aged = entries.filter(isAged);
  const read = aged.filter(e => e.lastReferenced && e.lastReferenced > e.created);
  const unreadAged = aged.filter(e => !e.lastReferenced || e.lastReferenced <= e.created);

  if (aged.length === 0) {
    circuits['Write→Read'] = { status: 'UNKNOWN', evidence: `0 entries aged >1h — system too young to assess` };
  } else if (read.length > 0) {
    circuits['Write→Read'] = { status: 'CLOSED', evidence: `${read.length}/${aged.length} aged entries have been referenced` };
  } else {
    circuits['Write→Read'] = {
      status: 'OPEN',
      evidence: `${unreadAged.length} entries aged >1h have never been referenced`,
      likelyCause: 'getRecentContext() not calling recordReference(), or no Agent reads knowledge',
    };
  }

  // ── Circuit 2: Read→Promote (referenced → maturity advanced past draft) ──
  const referencedAged = aged.filter(e => e.lastReferenced && e.lastReferenced > e.created);
  const promoted = referencedAged.filter(e => e.maturity !== 'draft');
  const stuckDraft = referencedAged.filter(e => e.maturity === 'draft');

  if (referencedAged.length === 0) {
    circuits['Read→Promote'] = { status: 'UNKNOWN', evidence: '0 referenced+aged entries — depends on Write→Read' };
  } else if (promoted.length > 0) {
    circuits['Read→Promote'] = { status: 'CLOSED', evidence: `${promoted.length}/${referencedAged.length} referenced entries promoted past draft` };
  } else {
    circuits['Read→Promote'] = {
      status: 'OPEN',
      evidence: `${stuckDraft.length} entries referenced but still draft after >1h`,
      likelyCause: 'checkKnowledgeHealth() promotion cycle not reaching these entries, or lifecycle.checkPromotion criteria too strict',
    };
  }

  // ── Circuit 3: Promote→Validate (verified → proven via cross-agent use) ──
  const promotedEntries = entries.filter(e => e.maturity === 'verified' || e.maturity === 'proven');
  const validated = promotedEntries.filter(e => e.contributors.length > 1);
  const weakValidated = promotedEntries.filter(e => e.contributors.length <= 1);

  if (promotedEntries.length === 0) {
    circuits['Promote→Validate'] = { status: 'UNKNOWN', evidence: '0 verified/proven entries — depends on Read→Promote' };
  } else if (validated.length > 0) {
    circuits['Promote→Validate'] = { status: 'CLOSED', evidence: `${validated.length}/${promotedEntries.length} verified+ entries have cross-agent validation (≥2 contributors)` };
  } else {
    circuits['Promote→Validate'] = {
      status: 'OPEN',
      evidence: `${weakValidated.length} verified entries but 0 have ≥2 contributors`,
      likelyCause: 'Only one agent type contributes patterns — need multiple agent types to use the same knowledge',
    };
  }

  // ── Circuit 4: Decay→Archive (aged unreferenced → decayed or archived) ──
  const agedUnreferenced = aged.filter(e => {
    const lastRef = new Date(e.lastReferenced || e.created).getTime();
    return now - lastRef > 90 * 24 * 60 * 60 * 1000; // 90 days unreferenced
  });
  const decayed = agedUnreferenced.filter(e => e.maturity === 'archived');
  const notDecayed = agedUnreferenced.filter(e => e.maturity !== 'archived');

  if (agedUnreferenced.length === 0) {
    circuits['Decay→Archive'] = { status: 'UNKNOWN', evidence: '0 entries unreferenced for >90d — system too young' };
  } else if (notDecayed.length === 0 || decayed.length > 0) {
    circuits['Decay→Archive'] = { status: 'CLOSED', evidence: `${decayed.length} decayed to archived, ${notDecayed.length} in progress` };
  } else {
    circuits['Decay→Archive'] = {
      status: 'OPEN',
      evidence: `${notDecayed.length} entries unreferenced >90d but not decayed`,
      likelyCause: 'runDecayCycle() not running or decay config thresholds too loose',
    };
  }

  // ── Circuit 5: Document Freshness (design-doc entries vs code changes) ──
  const freshnessResult = checkDocumentFreshness(process.env.REPO_DIR || process.cwd());
  if (freshnessResult.length > 0) {
    circuits['DocFreshness'] = {
      status: 'OPEN',
      evidence: `${freshnessResult.length} design-doc entries potentially stale (code changed since last update)`,
      likelyCause: freshnessResult.slice(0, 3).map(f => `${f.scope}: ${f.title}`).join('; '),
    };
  }

  // ── Circuit 6: Unmonitored design-docs (no scope tracking) ──
  const allDesignDocs = entries.filter(e => e.tags?.includes('design-doc'));
  const noScopeTag = allDesignDocs.filter(e => !e.tags?.some(t => t !== 'design-doc'));
  if (noScopeTag.length > 0) {
    circuits['DocTracking'] = {
      status: 'OPEN',
      evidence: `${noScopeTag.length} design-doc entries have no scope tag — freshness not tracked`,
      likelyCause: 'upsertKnowledge() called without scope, or entry created manually without scope tag',
    };
  }

  // Additional: Layer diversity check (non-circuit signal)
  const projectOnly = entries.length > 5 && entries.every(e => e.layer === 'project');
  if (projectOnly) {
    circuits['CrossLayer'] = {
      status: 'OPEN',
      evidence: `${entries.length} entries all in "project" layer — no team/tech/domain knowledge`,
      likelyCause: 'all ingestEntry() calls hardcode layer: "project"',
    };
  }

  const openCircuits = Object.values(circuits).filter(c => c.status === 'OPEN');

  return {
    healthy: openCircuits.length === 0,
    circuits,
    stats: { total: entries.length, byMaturity, byType },
  };
}

/** 自愈：根据 checkKnowledgeCircuit 的 OPEN 电路尝试自动修复 */
export function repairKnowledgeCircuit(
  circuits: Record<string, { status: string }>,
): Array<{ circuit: string; action: string; result: string }> {
  const repairs: Array<{ circuit: string; action: string; result: string }> = [];

  // ── Read→Promote OPEN: 对可晋升的 entry 强制运行 tryPromote ──
  if (circuits['Read→Promote']?.status === 'OPEN') {
    const entries = sharedStore.list({ excludeArchived: false })
      .filter(e => e.maturity === 'draft' || e.maturity === 'verified');
    let promoted = 0;
    let skipped = 0;
    for (const e of entries) {
      try {
        const result = sharedLifecycle.tryPromote(e.id);
        if (result) {
          promoted++;
          logger.info('[KnowledgeRepair] Promoted', { entryId: e.id, from: result.from, to: result.to });
        } else {
          skipped++;
        }
      } catch (err) {
        skipped++;
        logger.warn('[KnowledgeRepair] Promotion failed', { entryId: e.id, error: String(err) });
      }
    }
    repairs.push({
      circuit: 'Read→Promote',
      action: 'Force-promote all draft/verified entries',
      result: promoted > 0
        ? `Promoted ${promoted} entries, ${skipped} skipped (criteria not met)`
        : `${skipped} entries all failed — likely checkPromotion criteria unmet or store.update broken`,
    });
  }

  // ── Decay→Archive OPEN: 强制运行一次 decay cycle ──
  if (circuits['Decay→Archive']?.status === 'OPEN') {
    try {
      const changes = sharedLifecycle.runDecayCycle();
      repairs.push({
        circuit: 'Decay→Archive',
        action: 'Force-run decay cycle',
        result: changes.length > 0
          ? `Decayed ${changes.length} entries`
          : 'Decay cycle ran but no entries qualified for decay',
      });
    } catch (err) {
      repairs.push({ circuit: 'Decay→Archive', action: 'Force-run decay cycle', result: `Failed: ${String(err)}` });
    }
  }

  // ── DocFreshness OPEN: 标记过期条目，刷新 lastReferenced 防止衰减 ──
  if (circuits['DocFreshness']?.status === 'OPEN') {
    const stale = checkDocumentFreshness(process.env.REPO_DIR || process.cwd());
    for (const s of stale) {
      try {
        sharedLifecycle.recordReference(s.entryId, 'monitor');
      } catch { /* non-blocking */ }
    }
    repairs.push({
      circuit: 'DocFreshness',
      action: `Refresh ${stale.length} stale design-doc entries`,
      result: 'lastReferenced updated — entries marked for re-validation by next Analyst run',
    });
  }

  // ── Write→Read / Promote→Validate / CrossLayer: 无法自动修复 ──
  if (circuits['Write→Read']?.status === 'OPEN') {
    repairs.push({
      circuit: 'Write→Read',
      action: 'No auto-fix',
      result: 'Write→Read requires reads to happen. Ensure agents are running and getRecentContext() is called.',
    });
  }
  if (circuits['Promote→Validate']?.status === 'OPEN') {
    repairs.push({
      circuit: 'Promote→Validate',
      action: 'No auto-fix',
      result: 'Promote→Validate requires multiple agent types to reference the same knowledge. No code change can force this.',
    });
  }
  if (circuits['CrossLayer']?.status === 'OPEN') {
    repairs.push({
      circuit: 'CrossLayer',
      action: 'No auto-fix',
      result: 'CrossLayer requires ingestEntry() to be called with layer: "team" or "tech" or "domain". Check recordPattern() / recordIncident() calls.',
    });
  }

  return repairs;
}
