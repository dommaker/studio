/**
 * UnifiedQuery — dual-store unified query layer.
 * Wraps Prisma (structured data) + KnowledgeStore (narrative knowledge).
 * Consumer-facing API: buildKnowledgeContext, Studio UI, search.
 */
import { prisma } from '@dommaker/studio-prisma';
import { KnowledgeStore } from '@dommaker/harness';
import type { KnowledgeEntry as HarnessEntry, QueryFilter as HarnessFilter } from '@dommaker/harness';
import { UNIFIED_KNOWLEDGE_DIR } from '../knowledge-bus.service.js';

// ── Types ──────────────────────────────────────────────────

/** Harness KnowledgeEntry extended with Studio-specific applicableAgents */
type StudioEntry = HarnessEntry & { applicableAgents?: string[] };

export interface IndexEntry {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  source: 'prisma' | 'store';
  applicableAgents?: string[];
}

export interface UnifiedQueryFilter {
  consumptionModes?: string[];
  tags?: string[];
  origins?: string[];
  maturity?: string[];
  excludeTags?: string[];
  agentType?: string;
  sources?: ('prisma' | 'store')[];
  limit?: number;
  sortBy?: 'maturity' | 'lastReferenced' | 'createdAt';
}

// ── UnifiedQuery ───────────────────────────────────────────

export class UnifiedQuery {
  private store: KnowledgeStore;

  constructor(store?: KnowledgeStore) {
    this.store = store ?? new KnowledgeStore({ baseDir: UNIFIED_KNOWLEDGE_DIR });
  }

  /**
   * Get full entries (rule/context injection use).
   * Converts Prisma structured data → KnowledgeEntry format.
   */
  async queryEntries(filter: UnifiedQueryFilter): Promise<StudioEntry[]> {
    const entries: StudioEntry[] = [];

    if (!filter.sources || filter.sources.includes('prisma')) {
      entries.push(...await this.prismaToEntries(filter));
    }

    // Agent filtering
    if (filter.agentType) {
      return entries.filter(e =>
        !e.applicableAgents?.length || e.applicableAgents.includes(filter.agentType!),
      );
    }
    return entries;
  }

  /**
   * Get lightweight indexes (signal injection use).
   * Reads from KnowledgeStore, returns summary-level entries.
   */
  getIndexes(filter: UnifiedQueryFilter): IndexEntry[] {
    const harnessFilter: HarnessFilter = {};
    if (filter.consumptionModes?.length) {
      harnessFilter.consumptionModes = filter.consumptionModes as HarnessEntry['consumptionMode'][];
    }
    if (filter.tags?.length) {
      harnessFilter.tags = filter.tags;
    }

    let entries = this.store.list(harnessFilter);

    // Exclude low_quality
    if (filter.excludeTags?.includes('low_quality')) {
      entries = entries.filter(e => !e.tags.includes('low_quality'));
    }

    // Limit
    if (filter.limit) {
      entries = entries.slice(0, filter.limit);
    }

    return entries.map(e => ({
      id: e.id,
      title: e.title,
      summary: (e as any).summary || e.content.slice(0, 100),
      tags: e.tags,
      source: 'store' as const,
      applicableAgents: (e as any).applicableAgents,
    }));
  }

  /**
   * Count entries across both stores.
   */
  async count(filter?: UnifiedQueryFilter): Promise<number> {
    let count = 0;

    // Prisma count
    if (!filter?.sources || filter.sources.includes('prisma')) {
      if (filter?.consumptionModes?.includes('rule')) {
        count += await prisma.businessRule.count({ where: { status: 'active' } });
      }
      if (filter?.consumptionModes?.includes('context')) {
        const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
        if (pref) count++;
        const env = await prisma.environmentSnapshot.findFirst({ orderBy: { createdAt: 'desc' } });
        if (env) count++;
      }
    }

    // KnowledgeStore count
    if (!filter?.sources || filter.sources.includes('store')) {
      const harnessFilter: HarnessFilter = {};
      if (filter?.consumptionModes?.length) {
        harnessFilter.consumptionModes = filter.consumptionModes as HarnessEntry['consumptionMode'][];
      }
      count += this.store.list(harnessFilter).length;
    }

    return count;
  }

  // ── Prisma → KnowledgeEntry conversion ─────────────────

  private async prismaToEntries(filter: UnifiedQueryFilter): Promise<StudioEntry[]> {
    const entries: StudioEntry[] = [];
    const modes = filter.consumptionModes ?? [];

    // UserPreference → context entry
    if (modes.includes('context')) {
      const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
      if (pref) {
        entries.push(this.preferenceToEntry(pref));
      }
    }

    // BusinessRule → rule entries
    if (modes.includes('rule')) {
      const rules = await prisma.businessRule.findMany({ where: { status: 'active' } });
      for (const rule of rules) {
        entries.push(this.ruleToEntry(rule));
      }
    }

    // EnvironmentSnapshot → context entry
    if (modes.includes('context')) {
      const env = await prisma.environmentSnapshot.findFirst({ orderBy: { createdAt: 'desc' } });
      if (env) {
        entries.push(this.envToEntry(env));
      }
    }

    return entries;
  }

  private preferenceToEntry(pref: any): StudioEntry {
    const parts: string[] = [];
    if (pref.preferredModel) parts.push(`偏好模型: ${pref.preferredModel}`);
    if (pref.responseStyle) parts.push(`回复风格: ${pref.responseStyle}`);
    if (pref.activeHours && pref.activeHours !== '[]') parts.push(`活跃时段: ${pref.activeHours}`);
    if (pref.favoriteTools && pref.favoriteTools !== '[]') parts.push(`常用工具: ${pref.favoriteTools}`);
    if (pref.autoApproveThreshold != null) parts.push(`自动批准阈值: ${pref.autoApproveThreshold}`);
    if (pref.confidence) parts.push(`置信度: ${pref.confidence}`);

    return {
      id: 'pref:user',
      type: 'guideline',
      title: '用户偏好',
      content: parts.join('；') || '暂无偏好数据',
      maturity: 'active',
      layer: 'system',
      created: pref.createdAt?.toISOString?.() ?? String(pref.createdAt),
      lastReferenced: pref.updatedAt?.toISOString?.() ?? String(pref.updatedAt),
      contributors: [],
      projects: [],
      tags: ['preference', 'user'],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'context',
      origin: 'system',
      applicableAgents: [],
    };
  }

  private ruleToEntry(rule: any): StudioEntry {
    const affects: string[] = this.safeParseJson(rule.affects, []);
    const parts: string[] = [rule.description];
    if (rule.condition) parts.push(`条件: ${rule.condition}`);
    if (rule.action) parts.push(`动作: ${rule.action}`);

    return {
      id: `rule:${rule.name}`,
      type: 'guideline',
      title: rule.name,
      content: parts.join('；'),
      maturity: 'active',
      layer: 'system',
      created: rule.createdAt?.toISOString?.() ?? String(rule.createdAt),
      lastReferenced: rule.updatedAt?.toISOString?.() ?? String(rule.updatedAt),
      contributors: [],
      projects: [],
      tags: [rule.category],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'rule',
      origin: 'system',
      applicableAgents: affects,
    };
  }

  private envToEntry(env: any): StudioEntry {
    const limitations: string[] = this.safeParseJson(env.knownLimitations, []);
    const parts: string[] = [];
    if (env.platform) parts.push(`平台: ${env.platform}`);
    if (env.nodeVersion) parts.push(`Node: ${env.nodeVersion}`);
    if (env.nodeEnv) parts.push(`环境: ${env.nodeEnv}`);
    if (limitations.length) parts.push(`已知限制: ${limitations.join(', ')}`);

    return {
      id: 'env:current',
      type: 'guideline',
      title: '环境快照',
      content: parts.join('；') || '暂无环境数据',
      maturity: 'active',
      layer: 'system',
      created: env.createdAt?.toISOString?.() ?? String(env.createdAt),
      lastReferenced: env.createdAt?.toISOString?.() ?? String(env.createdAt),
      contributors: [],
      projects: [],
      tags: ['environment'],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'context',
      origin: 'system',
      applicableAgents: [],
    };
  }

  private safeParseJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
}
