/**
 * Skill 定义类型
 *
 * Skill 是 Agent 执行时可加载的能力模块。
 * 元数据 + prompt 内容，按需通过 MCP loadSkill 加载。
 */

export interface SkillDefinition {
  /** 唯一标识，如 'tdd-workflow' */
  id: string;
  /** 显示名称 */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 适用的 Agent 类型 */
  agentTypes: string[];
  /** 依赖的其他 skill id（可选） */
  requires?: string[];
  /** 关联的 tool name（可选） */
  tools?: string[];
  /** 执行档位（fast/standard/…；frontmatter 可选字段，缺省 standard） */
  tier?: string;
  /** 注入到 Agent prompt 的内容 */
  prompt: string;
}
