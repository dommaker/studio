/**
 * SkillLoader API Service - file-based skill loading with session lifecycle
 *
 * Wraps @dommaker/studio-skill package loader.
 * Adds: session-level load cache（生产调用方仅 mcp/skill.tools.ts 的 loadSkill）。
 *
 * #75: loadSkill lifecycle
 * #172（#60 决策 Q2）：knowledge:skill_used 唯一语义 = Skill 加载（本文件发射点），
 * 携带 workUnitId（调用方已知时）；经 writeStudioEvent 落盘（envelope level=debug），
 * 替代模块加载期固化的直连路径（修复测试期假 id 写入生产事件文件的污染漏洞）。
 */

// string type removed — using string. See packages/studio-skill/src/types.ts
import { logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import * as fs from 'fs';
import * as path from 'path';
import { writeStudioEvent } from '../../utils/studio-events.js';

// ── Types ──

export interface LoadedSkill {
  skillId: string;
  name: string;
  prompt: string;
  tools: string[];
  tier: string;
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
  /** #172: WU 归属（skill_used 事件 payload；调用方已知时传入） */
  workUnitId?: string;
}

// ── File-based skill loading (.md with frontmatter) ──

const SKILLS_DIR = process.env.SKILLS_DIR || studioPath('skills');

interface SkillFrontmatter {
  name: string;
  description?: string;
  agentTypes?: string[];
  tier?: string;
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
    let tier: string;
    let required: string[];

    if (!fileSkill) {
      logger.warn('[SkillLoader] Skill not found on disk', { skillName });
      return null;
    }

    skillId = `file:${skillName}`;
    prompt = fileSkill.prompt;
    tools = fileSkill.meta.tools || [];
    tier = (fileSkill.meta.tier || 'standard') as string;
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

    // S3 Gap 3c + #172（#60 决策 Q2）: skill_used 唯一语义 = Skill 加载，补 workUnitId；
    // 经 writeStudioEvent 统一入口落盘（envelope level=debug，测试期走隔离事件文件）
    void writeStudioEvent('knowledge:skill_used', {
      skillName,
      skillId,
      ...(options.workUnitId ? { workUnitId: options.workUnitId } : {}),
    }, { source: 'skill-loader' }).catch(() => {});

    logger.info('[SkillLoader] Loaded skill', {
      sessionId,
      skillName,
      tier: loaded.tier,
      toolCount: tools.length,
      source: 'file',
    });

    return loaded;
  }

}

/** Singleton */
export const skillLoaderService = new SkillLoaderService();
