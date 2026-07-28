/**
 * SkillLoader API Service - file-based skill loading with session lifecycle
 *
 * Wraps @dommaker/studio-skill package loader.
 * Adds: session-level load/unload.
 *
 * #75: load/unload lifecycle
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

// ── Types ──

export interface LoadedSkill {
  skillId: string;
  name: string;
  prompt: string;
  tools: string[];
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

// ── File-based skill loading (.md with frontmatter) ──

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');

interface SkillFrontmatter {
  name: string;
  description?: string;
  agentTypes?: string[];
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
    const filePath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;
    if (parsed.meta.status && parsed.meta.status !== 'published') return null;
    return { meta: parsed.meta, prompt: parsed.body };
  } catch {
    return null;
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

const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');
const fileStore = new FileStore();

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
    let required: string[];

    if (!fileSkill) {
      logger.warn('[SkillLoader] Skill not found on disk', { skillName });
      return null;
    }

    skillId = `file:${skillName}`;
    prompt = fileSkill.prompt;
    tools = fileSkill.meta.tools || [];
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
      loadedAt: new Date(),
    };

    state.loaded.set(skillName, loaded);

    // S3 Gap 3c: emit skill_used for knowledge_skill_usage_rate metric
    fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
      type: 'knowledge:skill_used',
      source: 'skill-loader',
      payload: JSON.stringify({ skillName, skillId }),
      createdAt: new Date().toISOString(),
    }).catch(() => {});

    logger.info('[SkillLoader] Loaded skill', {
      sessionId,
      skillName,
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
