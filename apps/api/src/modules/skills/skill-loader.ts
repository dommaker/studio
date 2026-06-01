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
  companyId?: string;
}

// ── Tier → tool access mapping ──

const TIER_TOOL_ACCESS: Record<SkillTier, Set<string>> = {
  fast: new Set(['Read', 'Glob', 'Grep', 'Bash']),
  standard: new Set(['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'NotebookEdit']),
  premium: new Set(['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']),
};

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

    // Find skill in DB
    const skill = await prisma.skill.findFirst({
      where: { name: skillName, status: 'published' },
    });
    if (!skill) {
      logger.warn('[SkillLoader] Skill not found or not published', { skillName });
      return null;
    }

    // Parse tools
    const tools: string[] = skill.tools ? JSON.parse(skill.tools) : [];

    // Load required skills recursively
    const required: string[] = skill.required ? JSON.parse(skill.required) : [];
    for (const reqName of required) {
      if (!state.loaded.has(reqName)) {
        await this.loadSkill({ sessionId, skillName: reqName, agentType });
      }
    }

    const loaded: LoadedSkill = {
      skillId: skill.id,
      name: skill.name,
      prompt: skill.prompt || '',
      tools,
      tier: (skill.tier || 'standard') as SkillTier,
      loadedAt: new Date(),
    };

    state.loaded.set(skillName, loaded);

    // Inject into package-level loader for prompt formatting
    const definition: SkillDefinition = {
      id: skill.name,
      name: skill.name,
      description: skill.description || '',
      trigger: (skill.trigger || 'always') as SkillTrigger,
      agentTypes: skill.agentTypes ? JSON.parse(skill.agentTypes) : [agentType],
      tier: (skill.tier || 'standard') as SkillTier,
      tools,
      prompt: skill.prompt || '',
    };

    logger.info('[SkillLoader] Loaded skill', {
      sessionId,
      skillName,
      tier: loaded.tier,
      toolCount: tools.length,
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
    const { sessionId, trigger, agentType, tier = 'standard', companyId } = options;

    const where: Record<string, unknown> = { status: 'published' };
    if (companyId) where.companyId = companyId;

    const skills = await prisma.skill.findMany({ where });

    const tierRank: Record<string, number> = { fast: 1, standard: 2, premium: 3 };
    const targetRank = tierRank[tier] ?? 2;

    const matched: LoadedSkill[] = [];
    for (const skill of skills) {
      // Filter by trigger
      const skillTrigger = skill.trigger || 'always';
      if (skillTrigger !== 'always' && skillTrigger !== trigger) continue;

      // Filter by agentType
      const agentTypes: string[] = skill.agentTypes ? JSON.parse(skill.agentTypes) : [];
      if (agentTypes.length > 0 && !agentTypes.includes(agentType)) continue;

      // Filter by tier (skill tier must be <= session tier)
      const skillTier = (skill.tier || 'standard') as SkillTier;
      if (tierRank[skillTier] > targetRank) continue;

      const loaded = await this.loadSkill({ sessionId, skillName: skill.name, agentType });
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
