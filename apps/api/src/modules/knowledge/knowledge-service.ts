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
  KnowledgeType,
} from '@dommaker/harness';
import { logger } from '@dommaker/studio-shared';

// ── Type mapping (absorbed from KnowledgeBus) ──

const ENTRY_TYPE_MAP: Record<string, KnowledgeType> = {
  pattern: 'guideline',
  failure: 'pitfall',
  incident: 'pitfall',
  pitfall: 'pitfall',
  guideline: 'guideline',
  trend: 'process',
  fix: 'guideline',
  analyst_accuracy: 'model',
  review: 'guideline',
  alert: 'pitfall',
  audit: 'guideline',
  deploy: 'guideline',
  gap: 'guideline',
  resolution: 'guideline',
};

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

// ── Studio-side types ──

export interface PatternEntry {
  type: string;
  title: string;
  content: string;
  tags: string[];
  maturity?: MaturityLevel;
}

export interface IncidentEntry {
  title: string;
  content: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
}

export interface TrendEntry {
  title: string;
  content: string;
  metric: string;
  tags: string[];
}

export interface AccuracyData {
  analystId: string;
  prediction: string;
  actual: string;
  accurate: boolean;
  timestamp: string;
}

export interface ExtractionResult {
  task: string;
  diff: string;
  success: boolean;
  duration: number;
  agentType: string;
  consumedKnowledge: string[];
}

export interface ExecutionOutcome {
  executionId: string;
  agentType: string;
  consumedKnowledge: string[];
  success: boolean;
  details: string;
  timestamp: string;
  mode?: 'external_agent' | 'channel' | 'pipeline';
}

export interface InjectOpts {
  tags?: string[];
  maxTokens?: number;
  includeRules?: boolean;
}

export interface SearchOpts {
  limit?: number;
  tags?: string[];
  type?: string;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;
  highlights: string[];
}

export interface FlywheelMetrics {
  quality: number;
  hitRate: number;
  improvement: number;
  freshness: number;
  timestamp: string;
}

export interface HealthReport {
  score: number;
  totalEntries: number;
  staleEntries: number;
  orphanEntries: number;
  duplicateEntries: number;
  timestamp: string;
}

export interface AuditReport {
  findings: AuditFinding[];
  trend: string;
  timestamp: string;
}

export interface AuditFinding {
  type: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  entryId?: string;
}

export interface AccuracyReport {
  overallAccuracy: number;
  byAnalyst: Record<string, number>;
  recentPredictions: AccuracyData[];
  timestamp: string;
}

// ── Dependencies interface ──

export interface KnowledgeServiceDeps {
  store: KnowledgeStore;
  lifecycle: KnowledgeLifecycle;
  ingest: KnowledgeIngest;
  linter: KnowledgeLinter;
  prisma: any; // PrismaClient
  query: any;  // UnifiedQuery
  eventEmitter: any; // EventEmitter
}

// ── KnowledgeService ─────────────────────────────────────────

export class KnowledgeService {
  private store: KnowledgeStore;
  private lifecycle: KnowledgeLifecycle;
  private ingest: KnowledgeIngest;
  private linter: KnowledgeLinter;
  private prisma: any;
  private query: any;
  private eventEmitter: any;

  constructor(deps: KnowledgeServiceDeps) {
    this.store = deps.store;
    this.lifecycle = deps.lifecycle;
    this.ingest = deps.ingest;
    this.linter = deps.linter;
    this.prisma = deps.prisma;
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

    await this.recordPattern({
      type: result.success ? 'pattern' : 'failure',
      title,
      content,
      tags: ['execution', result.agentType],
    });

    // Record outcome for consumed knowledge entries
    if (result.consumedKnowledge.length > 0) {
      this.recordConsumption(result.consumedKnowledge, `execution:${result.agentType}`);
    }

    this.eventEmitter.emit('knowledge', { type: 'extractFromExecution', data: { agentType: result.agentType, success: result.success } });
  }

  async extractFromConversation(_messages: { role: string; content: string }[]): Promise<void> {
    // Phase 5: new capability
  }

  async recordPattern(entry: PatternEntry): Promise<void> {
    try {
      const source = entry.tags?.[0] || 'monitor';

      // Triage quality gate: require root_cause + fix_action
      if (entry.type === 'triage') {
        const content = (entry.content || '').toLowerCase();
        if (!content.includes('root_cause') || !content.includes('fix_action')) {
          return; // silently skip invalid triage entries
        }
      }

      // Validate entry quality — mark low_quality instead of rejecting
      const tags: string[] = [entry.type];
      const knowledgeType = ENTRY_TYPE_MAP[entry.type] || 'guideline';
      const issues = this.linter.validateEntry({
        title: entry.title || '',
        content: entry.content || '',
        tags,
        type: knowledgeType,
      });
      const blockers = issues.filter((i: any) => i.severity === 'high');
      if (blockers.length > 0) {
        tags.push('low_quality');
      }

      this.ingest.ingestEntry(
        {
          type: knowledgeType,
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
    } catch {
      // best-effort
    }
  }

  async recordTrend(entry: TrendEntry): Promise<void> {
    try {
      this.ingest.ingestEntry(
        {
          type: 'process' as KnowledgeType,
          title: entry.title,
          content: entry.content,
          tags: ['trend'],
        },
        {
          source: `trend:auditor:${new Date().toISOString()}`,
          layer: 'project',
          maturity: 'active',
          tags: ['trend'],
          consumptionMode: 'signal',
        },
      );
    } catch {
      // best-effort
    }
  }

  async recordAnalystAccuracy(_data: AccuracyData): Promise<void> {
    // Phase 1C: absorb from KnowledgeBus.recordAnalystAccuracy
  }

  // ═══════════ Consume (read knowledge) ════════════

  async injectContext(agentType: string, _opts?: InjectOpts): Promise<string> {
    const sections: string[] = [];
    const injectedIds: string[] = [];

    // 1. rule — full content injection (constraints must be followed)
    const rules = await this.query.queryEntries({ consumptionModes: ['rule'], agentType });
    if (rules.length) {
      const lines = rules.map((r: any) => `- ${stripFormat(r.content)}`);
      sections.push(`## 系统约束\n${lines.join('\n')}`);
      injectedIds.push(...rules.map((r: any) => r.id));
    }

    // 2. context — full content injection (preferences + environment)
    const context = await this.query.queryEntries({ consumptionModes: ['context'] });
    if (context.length) {
      const lines = context.map((c: any) => `- ${stripFormat(c.content)}`);
      sections.push(`## 上下文\n${lines.join('\n')}`);
      injectedIds.push(...context.map((c: any) => c.id));
    }

    // 3. signal — index injection (informational)
    const signals = this.query.getIndexes({ consumptionModes: ['signal'], limit: 5 });
    if (signals.length) {
      const lines = signals.map((s: any) => `- [${s.id}] ${s.summary}`);
      sections.push(`## 近期信号\n${lines.join('\n')}`);
      injectedIds.push(...signals.map((s: any) => s.id));
    }

    // 4. reference — hint only
    const refCount = await this.query.count({ consumptionModes: ['reference'] });
    if (refCount > 0) {
      sections.push(`[知识库: ${refCount} 条参考，遇到问题时用 search()]`);
    }

    // 5. recordReference — close maturity loop
    if (injectedIds.length > 0) {
      for (const id of injectedIds) {
        try { this.lifecycle.recordReference(id, 'prompt-inject'); } catch { /* non-blocking */ }
      }
    }

    return sections.join('\n\n');
  }

  async search(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
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

  async matchResolutions(problem: string): Promise<KnowledgeEntry[]> {
    try {
      const candidates = await this.prisma.resolution.findMany({
        where: { status: { in: ['verified', 'canonical'] } },
        orderBy: { verifyCount: 'desc' },
      });

      const matched: any[] = [];
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
            title: row.title || pattern,
            content: row.fix || '',
            type: 'guideline',
            maturity: row.status === 'canonical' ? 'proven' : 'verified',
            tags: ['resolution', row.errorClass || ''].filter(Boolean),
            layer: 'project',
            created: row.createdAt?.toISOString?.() || '',
            lastReferenced: row.updatedAt?.toISOString?.() || '',
            contributors: [],
            projects: [],
            applicablePhases: [],
            sourceReferences: [],
            referencedBy: [],
            executionResults: [],
            consumptionMode: 'reference',
            origin: 'system',
          });
        }
      }

      return matched;
    } catch {
      return [];
    }
  }

  async list(filter?: QueryFilter): Promise<KnowledgeEntry[]> {
    return this.query.listEntries(filter || {});
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    return this.store.get(id);
  }

  // ═══════════ Track (consumption + outcome tracking) ════════════

  recordConsumption(entryIds: string[], context: string): void {
    for (const id of entryIds) {
      try { this.lifecycle.recordReference(id, context); } catch { /* non-blocking */ }
    }
  }

  async recordOutcome(outcome: ExecutionOutcome): Promise<void> {
    // Close the feedback loop: record execution outcome as StudioEvent
    try {
      await this.prisma.studioEvent.create({
        data: {
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
        },
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

  async recordFeedback(_entryId: string, _useful: boolean, _reason?: string): Promise<void> {
    // Phase 5: human feedback
  }

  /**
   * Record per-step pipeline feedback as StudioEvent.
   * Called after each pipeline phase (analyst/executor/review/deploy) completes.
   */
  async pipelineStepFeedback(params: {
    goalId: string;
    executionId: string;
    phase: string;
    success: boolean;
    durationMs: number;
    tokensUsed?: number;
    error?: string;
  }): Promise<void> {
    try {
      await this.prisma.studioEvent.create({
        data: {
          type: `knowledge:pipeline:${params.phase}:${params.success ? 'success' : 'failure'}`,
          source: 'pipeline',
          payload: JSON.stringify(params),
        },
      });
    } catch (e) { logger.warn('[KnowledgeService] pipelineStepFeedback failed', { error: String(e) }); }

    this.eventEmitter.emit('knowledge', {
      type: 'pipelineStepFeedback',
      data: { goalId: params.goalId, phase: params.phase, success: params.success },
    });
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

  async createResolution(problem: string, fix: string): Promise<void> {
    try {
      const existing = await this.prisma.resolution.findFirst({ where: { pattern: problem } });
      if (existing) return;
      await this.prisma.resolution.create({
        data: {
          pattern: problem,
          fix,
          status: 'pending',
          title: problem.slice(0, 100),
          errorClass: 'unknown',
        },
      });
    } catch {
      // best-effort
    }
  }

  // ═══════════ Measure (metrics + audit) ════════════

  async getFlywheelMetrics(): Promise<FlywheelMetrics> {
    try {
      const entries = this.store.list({});
      const total = entries.length;
      if (total === 0) return { quality: 0, hitRate: 0, improvement: 0, freshness: 0, timestamp: new Date().toISOString() };

      // Quality: weighted maturity score (proven=3, verified=2, draft=1)
      const maturityWeight: Record<string, number> = { proven: 3, verified: 2, active: 1.5, draft: 1, deprecated: 0, archived: 0 };
      const qualitySum = entries.reduce((s: number, e: any) => s + (maturityWeight[e.maturity] || 0), 0);
      const quality = Math.min(100, Math.round((qualitySum / (total * 3)) * 100));

      // Freshness: % referenced in last 30 days
      const now = Date.now();
      const recentCount = entries.filter((e: any) =>
        e.lastReferenced && (now - new Date(e.lastReferenced).getTime()) < 30 * 86400000
      ).length;
      const freshness = Math.round((recentCount / total) * 100);

      return { quality, hitRate: 0, improvement: 0, freshness, timestamp: new Date().toISOString() };
    } catch {
      return { quality: 0, hitRate: 0, improvement: 0, freshness: 0, timestamp: new Date().toISOString() };
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

  async getAuditReport(): Promise<AuditReport> {
    return { findings: [], trend: 'stable', timestamp: new Date().toISOString() };
  }

  async getAnalystAccuracy(): Promise<AccuracyReport> {
    return { overallAccuracy: 0, byAnalyst: {}, recentPredictions: [], timestamp: new Date().toISOString() };
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
      const row = await this.prisma.resolution.findUnique({ where: { id } });
      if (!row) return;

      const newCount = row.verifyCount + 1;
      const newStatus = newCount >= 3 ? 'canonical' : (newCount >= 1 ? 'verified' : 'pending');

      await this.prisma.resolution.update({
        where: { id },
        data: {
          verifyCount: newCount,
          status: newStatus,
          lastVerifiedAt: new Date(),
        },
      });
    } catch {
      // best-effort
    }
  }
}

// ── Utilities (absorbed from KnowledgeBus / prompt-builder) ──

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
import { prisma } from '@dommaker/studio-prisma';
import {
  sharedStore,
  sharedLifecycle,
  sharedIngest,
  sharedQuery,
  sharedLinter,
} from './knowledge-bus.service';

export const knowledgeService = new KnowledgeService({
  store: sharedStore,
  lifecycle: sharedLifecycle,
  ingest: sharedIngest,
  linter: sharedLinter,
  prisma,
  query: sharedQuery,
  eventEmitter: new EventEmitter(),
});
