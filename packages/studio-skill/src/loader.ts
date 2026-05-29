/**
 * SkillLoader — 按 trigger 加载 Skill，注入 Agent prompt
 *
 * DB-backed with 5-minute TTL cache. Falls back to hardcoded definitions
 * when Prisma is not initialized (e.g., tests, CLI) or DB query fails.
 *
 * load() is synchronous — cache refreshes lazily in background.
 */

import type { SkillDefinition, SkillTrigger, SkillTier } from './types.js';
import { allSkillDefinitions } from './definitions/index.js';

export interface LoadOptions {
  trigger: SkillTrigger;
  agentType?: string;
  tier?: SkillTier;
  exclude?: string[];
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class SkillLoader {
  private skills: Map<string, SkillDefinition>;
  private prisma: any = null;
  private cache: SkillDefinition[] = allSkillDefinitions;
  private cacheTime = 0;
  private refreshing = false;

  constructor(customSkills?: SkillDefinition[]) {
    const skills = customSkills || allSkillDefinitions;
    this.skills = new Map(skills.map(s => [s.id, s]));
  }

  /**
   * Initialize with Prisma instance for DB-backed loading.
   * Call once at startup.
   */
  init(prisma: any): void {
    this.prisma = prisma;
    this.cacheTime = 0; // trigger refresh on next load()
    this.refreshCache(); // eager first load
  }

  /**
   * 按触发条件加载 Skill (synchronous)
   */
  load(options: LoadOptions): SkillDefinition[] {
    this.maybeRefreshCache();

    const { trigger, agentType, tier, exclude = [] } = options;

    return this.cache.filter(s => {
      if (exclude.includes(s.id)) return false;
      if (s.trigger !== 'always' && s.trigger !== trigger) return false;
      if (agentType && !s.agentTypes.includes(agentType)) return false;
      if (tier) {
        const tierRank: Record<string, number> = { fast: 1, standard: 2, premium: 3 };
        if (tierRank[s.tier] > tierRank[tier]) return false;
      }
      return true;
    });
  }

  /**
   * 获取单个 Skill
   */
  get(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  /**
   * 格式化 Skill 列表为 prompt 注入文本
   */
  formatForPrompt(skills: SkillDefinition[]): string {
    if (skills.length === 0) return '';
    return skills
      .filter(s => s.prompt)
      .map(s => `\n---\n${s.prompt}`)
      .join('');
  }

  /**
   * 获取所有已注册的 Skill
   */
  listAll(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  /**
   * Trigger background refresh if cache is stale.
   */
  private maybeRefreshCache(): void {
    if (!this.prisma) return;
    if (Date.now() - this.cacheTime < CACHE_TTL_MS) return;
    this.refreshCache();
  }

  /**
   * Refresh cache from DB in background (fire-and-forget).
   */
  private refreshCache(): void {
    if (this.refreshing || !this.prisma) return;
    this.refreshing = true;

    this.prisma.skill.findMany({ where: { status: 'published' } })
      .then((rows: any[]) => {
        if (rows.length > 0) {
          this.cache = rows.map(r => ({
            id: r.name,
            name: r.name,
            description: r.description || '',
            trigger: (r.trigger || 'always') as SkillTrigger,
            agentTypes: r.agentTypes ? JSON.parse(r.agentTypes) : [],
            tier: (r.tier || 'standard') as SkillTier,
            tools: r.tools ? JSON.parse(r.tools) : undefined,
            prompt: r.prompt || '',
          }));
          this.skills = new Map(this.cache.map(s => [s.id, s]));
        }
        this.cacheTime = Date.now();
      })
      .catch(() => { /* keep stale cache */ })
      .finally(() => { this.refreshing = false; });
  }
}

/** 单例 — 需要调用 init(prisma) 才能使用 DB */
export const skillLoader = new SkillLoader();
