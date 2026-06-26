/**
 * SkillLoader — 从磁盘加载 Skill，注入 Agent prompt
 *
 * 文件结构: ~/.studio/skills/<skillName>/SKILL.md
 * load() 同步返回——缓存 5 分钟自动刷新。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SkillDefinition, SkillTier } from './types.js';

export interface LoadOptions {
  agentType?: string;
  tier?: SkillTier;
  exclude?: string[];
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get skills directory. Reads env var at runtime to support test isolation.
 */
function getSkillsDir(): string {
  return process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');
}

interface SkillFrontmatter {
  name: string;
  description?: string;
  agentTypes?: string[];
  tier?: SkillTier;
  tools?: string[];
  required?: string[];
  status?: string;
  version?: number;
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
    agentTypes: meta.agentTypes || [],
    tier: (meta.tier || 'standard') as SkillTier,
    tools: meta.tools,
    requires: meta.required,
    prompt,
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
   * Force refresh cache from disk.
   * Public API for scenarios where skills may have changed (e.g., test setup, admin reload).
   */
  refresh(): void {
    this.cacheTime = 0;
    this.refreshCache();
  }

  /**
   * 加载 Skill (synchronous)
   */
  load(options: LoadOptions): SkillDefinition[] {
    this.maybeRefreshCache();

    const { agentType, tier, exclude = [] } = options;

    return this.cache.filter(s => {
      if (exclude.includes(s.id)) return false;
      if (agentType && s.agentTypes.length > 0 && !s.agentTypes.includes(agentType)) return false;
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
   * Load a single skill from disk by name.
   * Searches <SKILLS_DIR>/<skillName>/SKILL.md
   * Returns null if not found, frontmatter invalid, or status not published.
   */
  private loadFromDisk(skillName: string): SkillDefinition | null {
    try {
      const skillsDir = getSkillsDir();
      const filePath = path.join(skillsDir, skillName, 'SKILL.md');
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseFrontmatter(raw);
      if (!parsed) return null;
      if (!parsed.meta.name || parsed.meta.name.trim() === '') return null;
      if (parsed.meta.status && parsed.meta.status !== 'published') return null;
      return frontmatterToSkillDefinition(parsed.meta, parsed.body);
    } catch {
      return null;
    }
  }

  /**
   * Load a single skill from disk and register it in the internal map.
   * Public API for loading individual skills on demand (e.g., via MCP loadSkill tool).
   *
   * @param skillName - The skill directory name (e.g., "tdd-workflow")
   * @returns The loaded SkillDefinition, or null if not found/invalid
   */
  loadSingle(skillName: string): SkillDefinition | null {
    const skill = this.loadFromDisk(skillName);
    if (skill) {
      this.skills.set(skill.id, skill);
    }
    return skill;
  }

  /**
   * Load all published skills from disk.
   * Scans <SKILLS_DIR>/<skillName>/SKILL.md structure.
   */
  private loadAllFromDisk(): SkillDefinition[] {
    try {
      const skillsDir = getSkillsDir();
      if (!fs.existsSync(skillsDir)) return [];
      const results: SkillDefinition[] = [];
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const filePath = path.join(skillsDir, entry.name, 'SKILL.md');
        if (!fs.existsSync(filePath)) continue;
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = parseFrontmatter(raw);
        if (!parsed) continue;
        if (!parsed.meta.name || parsed.meta.name.trim() === '') continue;
        if (parsed.meta.status && parsed.meta.status !== 'published') continue;
        results.push(frontmatterToSkillDefinition(parsed.meta, parsed.body));
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
   */
  private refreshCache(): void {
    if (this.refreshing) return;
    this.refreshing = true;

    const diskSkills = this.loadAllFromDisk();

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
