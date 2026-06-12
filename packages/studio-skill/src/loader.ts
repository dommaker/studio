/**
 * SkillLoader — 按 trigger 加载 Skill，注入 Agent prompt
 *
 * DB-backed with 5-minute TTL cache. Falls back to hardcoded definitions
 * when Prisma is not initialized (e.g., tests, CLI) or DB query fails.
 *
 * load() is synchronous — cache refreshes lazily in background.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SkillDefinition, SkillTrigger, SkillTier } from './types.js';

export interface LoadOptions {
  trigger: SkillTrigger;
  agentType?: string;
  tier?: SkillTier;
  exclude?: string[];
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');

interface SkillFrontmatter {
  name: string;
  description?: string;
  trigger?: SkillTrigger;
  agentTypes?: string[];
  tier?: SkillTier;
  tools?: string[];
  status?: string;
  version?: number;
  intentKeywords?: string[];
}

function parseFrontmatter(content: string): { meta: SkillFrontmatter; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const yaml = match[1];
  const body = match[2].trim();
  const meta: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { meta: meta as unknown as SkillFrontmatter, body };
}

function frontmatterToSkillDefinition(meta: SkillFrontmatter, prompt: string): SkillDefinition {
  return {
    id: meta.name,
    name: meta.name,
    description: meta.description || '',
    trigger: (meta.trigger || 'always') as SkillTrigger,
    agentTypes: meta.agentTypes || [],
    tier: (meta.tier || 'standard') as SkillTier,
    tools: meta.tools,
    prompt,
    intentKeywords: meta.intentKeywords,
  };
}

export class SkillLoader {
  private skills: Map<string, SkillDefinition>;
  private cache: SkillDefinition[] = [];
  private cacheTime = 0;
  private refreshing = false;
  private customSkillsProvided = false;

  constructor(customSkills?: SkillDefinition[]) {
    const skills = customSkills || [];
    this.skills = new Map(skills.map(s => [s.id, s]));
    this.cache = skills;
    this.customSkillsProvided = !!customSkills;
  }

  /**
   * Initialize — no-op, kept for backward compatibility.
   * Skills are loaded from disk only.
   */
  init(_prisma?: any): void {
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
   * 格式化 Skill 列表为元数据索引（name + description）
   *
   * 元数据+索引模式：只注入轻量索引，Agent 按需通过 loadSkill MCP tool 加载完整内容。
   * 相比旧版全量注入，token 节省 50%+。
   */
  formatForPrompt(skills: SkillDefinition[]): string {
    if (skills.length === 0) return '';
    return skills
      .map(s => `- **${s.name}**${s.description ? ': ' + s.description : ''}`)
      .join('\n');
  }

  /**
   * 获取单个 Skill 的完整 prompt（按需加载）
   *
   * Agent 通过 loadSkill MCP tool 调用此方法获取完整内容。
   */
  getFullPrompt(id: string): string | null {
    const skill = this.skills.get(id);
    return skill?.prompt || null;
  }

  /**
   * 获取所有已注册的 Skill
   */
  listAll(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  /**
   * Load a single skill from trigger subdirectories by name.
   * Searches all trigger subdirs for <SKILLS_DIR>/<trigger>/<skillName>/SKILL.md
   * Returns null if not found, frontmatter invalid, or status not published.
   */
  private loadFromDisk(skillName: string): SkillDefinition | null {
    try {
      if (!fs.existsSync(SKILLS_DIR)) return null;
      const triggers = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const trigger of triggers) {
        const filePath = path.join(SKILLS_DIR, trigger, skillName, 'SKILL.md');
        if (!fs.existsSync(filePath)) continue;
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = parseFrontmatter(raw);
        if (!parsed) continue;
        if (!parsed.meta.name || parsed.meta.name.trim() === '') continue;
        if (parsed.meta.status && parsed.meta.status !== 'published') continue;
        return frontmatterToSkillDefinition(parsed.meta, parsed.body);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Load all published skills from trigger subdirectories on disk.
   * Scans <SKILLS_DIR>/<trigger>/<skillName>/SKILL.md structure.
   * Returns empty array if SKILLS_DIR doesn't exist.
   */
  private loadAllFromDisk(): SkillDefinition[] {
    try {
      if (!fs.existsSync(SKILLS_DIR)) return [];
      const results: SkillDefinition[] = [];
      const triggers = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const trigger of triggers) {
        const triggerDir = path.join(SKILLS_DIR, trigger);
        const skills = fs.readdirSync(triggerDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const skillName of skills) {
          const filePath = path.join(triggerDir, skillName, 'SKILL.md');
          if (!fs.existsSync(filePath)) continue;
          const raw = fs.readFileSync(filePath, 'utf-8');
          const parsed = parseFrontmatter(raw);
          if (!parsed) continue;
          if (!parsed.meta.name || parsed.meta.name.trim() === '') continue;
          if (parsed.meta.status && parsed.meta.status !== 'published') continue;
          results.push(frontmatterToSkillDefinition(parsed.meta, parsed.body));
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  /**
   * Trigger background refresh if cache is stale.
   */
  private maybeRefreshCache(): void {
    if (this.customSkillsProvided) return;
    if (Date.now() - this.cacheTime < CACHE_TTL_MS) return;
    this.refreshCache();
  }

  /**
   * Refresh cache: load from disk, merge with existing cache.
   * Disk loading is synchronous.
   */
  private refreshCache(): void {
    if (this.refreshing) return;
    this.refreshing = true;

    // Load disk skills (synchronous)
    const diskSkills = this.loadAllFromDisk();

    // Merge — start with existing cache (preserves constructor customSkills), then overlay disk
    const merged = new Map<string, SkillDefinition>();
    for (const s of this.cache) merged.set(s.id, s);
    for (const s of diskSkills) merged.set(s.id, s);

    this.cache = [...merged.values()];
    this.skills = merged;
    this.cacheTime = Date.now();
    this.refreshing = false;
  }
}

/** 单例 — 需要调用 init(prisma) 才能使用 DB */
export const skillLoader = new SkillLoader();
