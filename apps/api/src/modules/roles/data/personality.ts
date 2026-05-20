/**
 * Personality System - Big Five 性格模型
 */

import { Personality, PersonalityTemplate, PersonalityBehaviorInfluence } from './personality-types';

/**
 * 预定义性格模板
 */
export const PERSONALITY_TEMPLATES: Record<string, PersonalityTemplate> = {
  // 用户模板
  picky_user: {
    id: 'picky_user',
    name: '挑剔型用户',
    description: '追求完美，容易发现问题，评分偏低',
    type: 'user',
    personality: { openness: 0.3, conscientiousness: 0.9, extraversion: 0.5, agreeableness: 0.2, neuroticism: 0.7 },
    behaviorInfluence: { codeQuality: 0.9, communicationStyle: 0.3, ratingTendency: -0.4, stanceAdherence: 0.8, feedbackLikelihood: 0.9 },
  },
  enthusiastic_user: {
    id: 'enthusiastic_user',
    name: '热情型用户',
    description: '积极乐观，容易满意，评分偏高',
    type: 'user',
    personality: { openness: 0.8, conscientiousness: 0.6, extraversion: 0.9, agreeableness: 0.8, neuroticism: 0.3 },
    behaviorInfluence: { codeQuality: 0.5, communicationStyle: 0.9, ratingTendency: 0.4, stanceAdherence: 0.3, feedbackLikelihood: 0.7 },
  },
  silent_user: {
    id: 'silent_user',
    name: '沉默型用户',
    description: '不爱反馈，难以捉摸',
    type: 'user',
    personality: { openness: 0.4, conscientiousness: 0.5, extraversion: 0.2, agreeableness: 0.3, neuroticism: 0.5 },
    behaviorInfluence: { codeQuality: 0.5, communicationStyle: 0.1, ratingTendency: 0, stanceAdherence: 0.5, feedbackLikelihood: 0.1 },
  },

  // 员工模板
  perfectionist: {
    id: 'perfectionist',
    name: '完美主义者',
    description: '追求极致，代码质量高，但可能较慢',
    type: 'employee',
    personality: { openness: 0.6, conscientiousness: 0.95, extraversion: 0.4, agreeableness: 0.3, neuroticism: 0.4 },
    behaviorInfluence: { codeQuality: 0.95, communicationStyle: 0.4, ratingTendency: 0, stanceAdherence: 0.9, feedbackLikelihood: 0.6 },
  },
  innovator: {
    id: 'innovator',
    name: '创新者',
    description: '勇于尝试新方案，可能冒险',
    type: 'employee',
    personality: { openness: 0.95, conscientiousness: 0.5, extraversion: 0.7, agreeableness: 0.6, neuroticism: 0.4 },
    behaviorInfluence: { codeQuality: 0.6, communicationStyle: 0.7, ratingTendency: 0.2, stanceAdherence: 0.4, feedbackLikelihood: 0.7 },
  },
  steady_worker: {
    id: 'steady_worker',
    name: '稳健派',
    description: '稳定可靠，按部就班',
    type: 'employee',
    personality: { openness: 0.4, conscientiousness: 0.8, extraversion: 0.5, agreeableness: 0.7, neuroticism: 0.2 },
    behaviorInfluence: { codeQuality: 0.75, communicationStyle: 0.6, ratingTendency: 0.1, stanceAdherence: 0.7, feedbackLikelihood: 0.5 },
  },
  challenger: {
    id: 'challenger',
    name: '质疑者',
    description: '善于发现问题，适合 reviewer 角色',
    type: 'employee',
    personality: { openness: 0.5, conscientiousness: 0.7, extraversion: 0.6, agreeableness: 0.2, neuroticism: 0.3 },
    behaviorInfluence: { codeQuality: 0.7, communicationStyle: 0.5, ratingTendency: -0.3, stanceAdherence: 0.9, feedbackLikelihood: 0.8 },
  },
};

/**
 * 性格系统类
 */
export class PersonalitySystem {
  private templates: Record<string, PersonalityTemplate>;

  constructor(customTemplates?: Record<string, PersonalityTemplate>) {
    this.templates = { ...PERSONALITY_TEMPLATES, ...customTemplates };
  }

  /**
   * 创建随机性格
   */
  createRandom(): Personality {
    return {
      openness: Math.random(),
      conscientiousness: Math.random(),
      extraversion: Math.random(),
      agreeableness: Math.random(),
      neuroticism: Math.random(),
    };
  }

  /**
   * 从模板创建性格
   */
  fromTemplate(templateId: string): Personality | null {
    const template = this.templates[templateId];
    return template ? { ...template.personality } : null;
  }

  /**
   * 创建带随机偏差的性格
   */
  fromTemplateWithVariance(templateId: string, variance: number = 0.1): Personality | null {
    const base = this.fromTemplate(templateId);
    if (!base) return null;

    return {
      openness: this.clamp(base.openness + (Math.random() - 0.5) * variance * 2),
      conscientiousness: this.clamp(base.conscientiousness + (Math.random() - 0.5) * variance * 2),
      extraversion: this.clamp(base.extraversion + (Math.random() - 0.5) * variance * 2),
      agreeableness: this.clamp(base.agreeableness + (Math.random() - 0.5) * variance * 2),
      neuroticism: this.clamp(base.neuroticism + (Math.random() - 0.5) * variance * 2),
    };
  }

  /**
   * 计算性格对行为的影响
   */
  calculateBehaviorInfluence(personality: Personality): PersonalityBehaviorInfluence {
    return {
      codeQuality: personality.conscientiousness,
      communicationStyle: (personality.extraversion + personality.agreeableness) / 2,
      ratingTendency: personality.agreeableness < 0.3 ? -0.4 : personality.agreeableness > 0.7 ? 0.4 : 0,
      stanceAdherence: (personality.conscientiousness + (1 - personality.agreeableness)) / 2,
      feedbackLikelihood: personality.extraversion,
    };
  }

  /**
   * 获取性格描述
   */
  describe(personality: Personality): string {
    const traits: string[] = [];

    if (personality.openness > 0.7) traits.push('创新');
    else if (personality.openness < 0.3) traits.push('保守');

    if (personality.conscientiousness > 0.7) traits.push('尽责');
    else if (personality.conscientiousness < 0.3) traits.push('随性');

    if (personality.extraversion > 0.7) traits.push('外向');
    else if (personality.extraversion < 0.3) traits.push('内向');

    if (personality.agreeableness > 0.7) traits.push('友善');
    else if (personality.agreeableness < 0.3) traits.push('挑剔');

    if (personality.neuroticism > 0.7) traits.push('情绪化');
    else if (personality.neuroticism < 0.3) traits.push('稳定');

    return traits.join('、') || '中性';
  }

  /**
   * 判断是否适合某立场
   */
  isSuitableForStance(personality: Personality, stance: string): boolean {
    const influence = this.calculateBehaviorInfluence(personality);

    const stanceRequirements: Record<string, (i: PersonalityBehaviorInfluence) => boolean> = {
      critic: (i) => (i.stanceAdherence ?? 0) > 0.6 && (i.ratingTendency ?? 0) < 0.1,
      supporter: (i) => (i.communicationStyle ?? 0) > 0.5 && (i.ratingTendency ?? 0) > -0.1,
      decider: (i) => (i.codeQuality ?? 0) > 0.5 && (i.stanceAdherence ?? 0) > 0.5,
      executor: (i) => (i.codeQuality ?? 0) > 0.5,
      tester: (i) => (i.stanceAdherence ?? 0) > 0.6 && personality.conscientiousness > 0.6,
      architect: (i) => personality.openness > 0.5 && (i.codeQuality ?? 0) > 0.6,
    };

    const check = stanceRequirements[stance];
    return check ? check(influence) : true;
  }

  /**
   * 获取所有模板
   */
  getTemplates(type?: 'user' | 'employee'): PersonalityTemplate[] {
    const all = Object.values(this.templates);
    return type ? all.filter(t => t.type === type) : all;
  }

  /**
   * 添加自定义模板
   */
  addTemplate(template: PersonalityTemplate): void {
    this.templates[template.id] = template;
  }

  /**
   * 限制值在 0-1 之间
   */
  private clamp(value: number): number {
    return Math.max(0, Math.min(1, value));
  }
}

export const createPersonalitySystem = (customTemplates?: Record<string, PersonalityTemplate>) =>
  new PersonalitySystem(customTemplates);
