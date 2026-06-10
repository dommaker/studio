/**
 * SkillLoader API Service — DB-driven skill loading with session lifecycle
 *
 * Wraps @dommaker/studio-skill package loader.
 * Adds: DB CRUD, session-level load/unload, tier-based tool permissions.
 *
 * #73: DB-driven loading
 * #75: load/unload lifecycle
 * #76: tier-based tool permission binding
 */

import { prisma } from '@dommaker/studio-prisma';
import { skillLoader, type SkillDefinition, type SkillTrigger, type SkillTier } from '@dommaker/studio-skill';
import { logger } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ──

export interface LoadedSkill {
  skillId: string;
  name: string;
  prompt: string;
  tools: string[];
  tier: SkillTier;
  loadedAt: Date;
}

export interface SessionSkillState {
  sessionId: string;
  agentType: string;
  loaded: Map<string, LoadedSkill>;
}

export interface LoadSkillOptions {
  sessionId: string;
  skillName: string;
  agentType?: string;
}

export interface UnloadSkillOptions {
  sessionId: string;
  skillName: string;
}

export interface LoadForSessionOptions {
  sessionId: string;
  trigger: SkillTrigger;
  agentType: string;
  tier?: SkillTier;
}

// ── Tier → tool access mapping ──

const TIER_TOOL_ACCESS: Record<SkillTier, Set<string>> = {
  fast: new Set(['Read', 'Glob', 'Grep', 'Bash']),
  standard: new Set(['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'NotebookEdit']),
  premium: new Set(['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']),
};

// ── File-based skill loading (.md with frontmatter) ──

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');

interface SkillFrontmatter {
  name: string;
  description?: string;
  trigger?: SkillTrigger;
  agentTypes?: string[];
  tier?: SkillTier;
  tools?: string[];
  required?: string[];
  status?: string;
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
    // Parse arrays: [a, b] or ["a", "b"]
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { meta: meta as unknown as SkillFrontmatter, body };
}

function loadSkillFromDisk(skillName: string): { meta: SkillFrontmatter; prompt: string } | null {
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
      if (parsed.meta.status && parsed.meta.status !== 'published') continue;
      return { meta: parsed.meta, prompt: parsed.body };
    }
    return null;
  } catch {
    return null;
  }
}

function loadAllSkillFiles(): SkillFrontmatter[] {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    const results: SkillFrontmatter[] = [];
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
        if (parsed.meta.status && parsed.meta.status !== 'published') continue;
        results.push(parsed.meta);
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Load skill metadata from specific trigger subdirectories.
 * Scans the given trigger + 'always/' directories only.
 */
function normalizeTriggerDir(trigger: string): string {
  return trigger.replace(/_/g, '-');
}

function loadSkillFilesForTrigger(trigger: string): SkillFrontmatter[] {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    const results: SkillFrontmatter[] = [];
    const dirsToScan = [normalizeTriggerDir(trigger), 'always'];
    for (const dir of dirsToScan) {
      const triggerDir = path.join(SKILLS_DIR, dir);
      if (!fs.existsSync(triggerDir)) continue;
      const skills = fs.readdirSync(triggerDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const skillName of skills) {
        const filePath = path.join(triggerDir, skillName, 'SKILL.md');
        if (!fs.existsSync(filePath)) continue;
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = parseFrontmatter(raw);
        if (!parsed) continue;
        if (parsed.meta.status && parsed.meta.status !== 'published') continue;
        results.push(parsed.meta);
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ── Session state store ──

const sessionStates = new Map<string, SessionSkillState>();

function getOrCreateSession(sessionId: string, agentType: string): SessionSkillState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = { sessionId, agentType, loaded: new Map() };
    sessionStates.set(sessionId, state);
  }
  return state;
}

// ── Service ──

export class SkillLoaderService {
  /**
   * Load a single skill into a session context.
   * Injects prompt + tools. Tracks loaded state.
   *
   * #75: loadSkill lifecycle
   */
  async loadSkill(options: LoadSkillOptions): Promise<LoadedSkill | null> {
    const { sessionId, skillName, agentType = 'executor' } = options;

    // Check if already loaded
    const state = getOrCreateSession(sessionId, agentType);
    if (state.loaded.has(skillName)) {
      return state.loaded.get(skillName)!;
    }

    // Try file-based loading first
    const fileSkill = loadSkillFromDisk(skillName);

    let skillId: string;
    let prompt: string;
    let tools: string[];
    let tier: SkillTier;
    let required: string[];

    if (!fileSkill) {
      logger.warn('[SkillLoader] Skill not found on disk', { skillName });
      return null;
    }

    skillId = `file:${skillName}`;
    prompt = fileSkill.prompt;
    tools = fileSkill.meta.tools || [];
    tier = (fileSkill.meta.tier || 'standard') as SkillTier;
    required = fileSkill.meta.required || [];

    // Load required skills recursively
    for (const reqName of required) {
      if (!state.loaded.has(reqName)) {
        await this.loadSkill({ sessionId, skillName: reqName, agentType });
      }
    }

    const loaded: LoadedSkill = {
      skillId,
      name: skillName,
      prompt,
      tools,
      tier,
      loadedAt: new Date(),
    };

    state.loaded.set(skillName, loaded);

    // S3 Gap 3c: emit skill_used for knowledge_skill_usage_rate metric
    prisma.studioEvent.create({
      data: {
        type: 'knowledge:skill_used',
        source: 'skill-loader',
        payload: JSON.stringify({ skillName, skillId }),
      },
    }).catch(() => {});

    logger.info('[SkillLoader] Loaded skill', {
      sessionId,
      skillName,
      tier: loaded.tier,
      toolCount: tools.length,
      source: 'file',
    });

    return loaded;
  }

  /**
   * Unload a skill from a session context.
   * Removes prompt + tools from loaded state.
   *
   * #75: unloadSkill lifecycle
   */
  unloadSkill(options: UnloadSkillOptions): boolean {
    const { sessionId, skillName } = options;
    const state = sessionStates.get(sessionId);
    if (!state) return false;

    const existed = state.loaded.has(skillName);
    state.loaded.delete(skillName);

    if (existed) {
      logger.info('[SkillLoader] Unloaded skill', { sessionId, skillName });
    }

    // Clean up empty sessions
    if (state.loaded.size === 0) {
      sessionStates.delete(sessionId);
    }

    return existed;
  }

  /**
   * Load all matching skills for a session based on trigger + agentType + tier.
   * Queries DB for published skills matching criteria.
   *
   * #73: DB-driven loading
   */
  async loadForSession(options: LoadForSessionOptions): Promise<LoadedSkill[]> {
    const { sessionId, trigger, agentType, tier = 'standard' } = options;

    const tierRank: Record<string, number> = { fast: 1, standard: 2, premium: 3 };
    const targetRank = tierRank[tier] ?? 2;

    const matched: LoadedSkill[] = [];

    // Load from trigger subdirectory + always/ subdirectory
    const fileSkills = loadSkillFilesForTrigger(trigger);
    for (const meta of fileSkills) {
      const agentTypes = meta.agentTypes || [];
      if (agentTypes.length > 0 && !agentTypes.includes(agentType)) continue;

      const skillTier = (meta.tier || 'standard') as SkillTier;
      if (tierRank[skillTier] > targetRank) continue;

      const loaded = await this.loadSkill({ sessionId, skillName: meta.name, agentType });
      if (loaded) matched.push(loaded);
    }

    return matched;
  }

  /**
   * Get all loaded skills for a session.
   */
  getSessionSkills(sessionId: string): LoadedSkill[] {
    const state = sessionStates.get(sessionId);
    if (!state) return [];
    return [...state.loaded.values()];
  }

  /**
   * Get the combined prompt from all loaded skills for a session.
   */
  getSessionPrompt(sessionId: string): string {
    const skills = this.getSessionSkills(sessionId);
    if (skills.length === 0) return '';
    return skills
      .filter(s => s.prompt)
      .map(s => `\n---\n${s.prompt}`)
      .join('');
  }

  /**
   * Get all allowed tools for a session (union of all loaded skill tools,
   * filtered by tier permission).
   *
   * #76: tier-based tool permission binding
   */
  getSessionTools(sessionId: string, tier: SkillTier = 'standard'): string[] {
    const skills = this.getSessionSkills(sessionId);
    const allowedByTier = TIER_TOOL_ACCESS[tier] || TIER_TOOL_ACCESS.standard;

    const tools = new Set<string>();
    for (const skill of skills) {
      for (const tool of skill.tools) {
        if (allowedByTier.has(tool)) {
          tools.add(tool);
        }
      }
    }
    return [...tools];
  }

  /**
   * Get allowed tools for a specific tier.
   * Used by tool permission service to enforce tier-based access.
   *
   * #76: tier-based tool permission binding
   */
  getToolsForTier(tier: SkillTier): string[] {
    return [...(TIER_TOOL_ACCESS[tier] || TIER_TOOL_ACCESS.standard)];
  }

  /**
   * Check if a tool is allowed for a given tier.
   *
   * #76: tier-based tool permission binding
   */
  isToolAllowedForTier(toolName: string, tier: SkillTier): boolean {
    const allowed = TIER_TOOL_ACCESS[tier] || TIER_TOOL_ACCESS.standard;
    return allowed.has(toolName);
  }

  /**
   * Clear all loaded skills for a session (cleanup).
   */
  clearSession(sessionId: string): void {
    sessionStates.delete(sessionId);
    logger.info('[SkillLoader] Cleared session', { sessionId });
  }

  /**
   * Get active session count (for monitoring).
   */
  getActiveSessionCount(): number {
    return sessionStates.size;
  }
}

/** Singleton */
export const skillLoaderService = new SkillLoaderService();
