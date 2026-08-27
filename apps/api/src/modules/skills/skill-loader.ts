/**
 * SkillLoader API Service - session 生命周期 + 事件上报
 *
 * #361（恢复工单42收敛决定）：磁盘加载归 @dommaker/studio-skill 包加载器
 * （loadSingle），本文件删除第三份 frontmatter 解析器（其数字解析弱于
 * studio-shared 的实现）；apps/api 侧只保留会话级 load 缓存与 skill_used
 * 事件发射。
 *
 * #75: loadSkill lifecycle
 * #172（#60 决策 Q2）：knowledge:skill_used 唯一语义 = Skill 加载（本文件发射点），
 * 携带 workUnitId（调用方已知时）；经 writeStudioEvent 落盘（envelope level=debug），
 * 替代模块加载期固化的直连路径（修复测试期假 id 写入生产事件文件的污染漏洞）。
 */

import { logger, writeStudioEvent } from '@dommaker/studio-shared';
import { skillLoader } from '@dommaker/studio-skill';

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

    // 磁盘加载走包版 SkillLoader（SKILLS_DIR 运行时读取，测试隔离不受影响）
    const def = skillLoader.loadSingle(skillName);
    if (!def) {
      logger.warn('[SkillLoader] Skill not found on disk', { skillName });
      return null;
    }

    const prompt = def.prompt;
    const tools = def.tools || [];
    const tier = def.tier || 'standard';
    const required = def.requires || [];
    const skillId = `file:${skillName}`;

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
