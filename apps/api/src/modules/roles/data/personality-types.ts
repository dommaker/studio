/**
 * 性格系统类型定义
 *
 * Big Five 模型
 */

export interface Personality {
  openness: number;          // 开放性 0-1
  conscientiousness: number; // 尽责性 0-1
  extraversion: number;      // 外向性 0-1
  agreeableness: number;     // 宜人性 0-1
  neuroticism: number;       // 神经质 0-1
}

export interface PersonalityTemplate {
  id: string;
  name: string;
  description?: string;
  personality: Personality;
  type: 'user' | 'employee';
  behaviorInfluence?: PersonalityBehaviorInfluence;
}

export interface PersonalityBehaviorInfluence {
  codeQuality?: number;
  communicationStyle?: number;
  ratingTendency?: number;
  stanceAdherence?: number;
  feedbackLikelihood?: number;
}
