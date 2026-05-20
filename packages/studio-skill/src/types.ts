/**
 * Skill 定义类型
 *
 * Skill 是 Agent 执行时可加载的能力模块。
 * 不是 prompt 模板——是有 trigger、tier、tool 的结构化实体。
 */

export type SkillTrigger =
  | 'goal_start'          // Goal 执行开始时加载
  | 'goal_continue'       // Session 2+ 续接时加载
  | 'review'              // Reviewer 审查时加载
  | 'knowledge_extract'   // KK 提取知识时加载
  | 'integration'         // 集成合并时加载
  | 'sub_agent'           // 子 Agent 执行时加载
  | 'always';             // 始终加载

export type SkillTier = 'fast' | 'standard' | 'premium';

export interface SkillDefinition {
  /** 唯一标识，如 'tdd-workflow' */
  id: string;
  /** 显示名称 */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 触发条件 */
  trigger: SkillTrigger;
  /** 适用的 Agent 类型 */
  agentTypes: string[];
  /** 推理档位（低于此档位不加载） */
  tier: SkillTier;
  /** 依赖的其他 skill id（可选） */
  requires?: string[];
  /** 关联的 tool name（可选） */
  tools?: string[];
  /** 注入到 Agent prompt 的内容 */
  prompt: string;
}
