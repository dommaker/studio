/**
 * SkillLoader — 按 trigger 加载 Skill，注入 Agent prompt
 */

import type { SkillDefinition, SkillTrigger, SkillTier } from './types.js';
import { allSkillDefinitions } from './definitions/index.js';

export interface LoadOptions {
  trigger: SkillTrigger;
  agentType?: string;
  tier?: SkillTier;
  exclude?: string[];
}

export class SkillLoader {
  private skills: Map<string, SkillDefinition>;

  constructor(customSkills?: SkillDefinition[]) {
    const skills = customSkills || allSkillDefinitions;
    this.skills = new Map(skills.map(s => [s.id, s]));
  }

  /**
   * 按触发条件加载 Skill
   */
  load(options: LoadOptions): SkillDefinition[] {
    const { trigger, agentType, tier, exclude = [] } = options;

    return allSkillDefinitions.filter(s => {
      // 排除
      if (exclude.includes(s.id)) return false;
      // 触发匹配（'always' 始终匹配）
      if (s.trigger !== 'always' && s.trigger !== trigger) return false;
      // Agent 类型匹配
      if (agentType && !s.agentTypes.includes(agentType)) return false;
      // Tier 门槛（skill 的 tier 高于请求的 tier 则不加载）
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
      .filter(s => s.prompt) // 跳过动态内容 skill（如 stuck-recovery）
      .map(s => `\n---\n${s.prompt}`)
      .join('');
  }

  /**
   * 获取所有已注册的 Skill
   */
  listAll(): SkillDefinition[] {
    return [...this.skills.values()];
  }
}

/** 单例 */
export const skillLoader = new SkillLoader();
