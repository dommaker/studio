/**
 * buildAgentContext — 统一 Agent 上下文构建器
 *
 * 将 Skill、Knowledge、Harness 约束、角色约束 组装为单一 prompt 注入块。
 * 所有 Agent 类型（Analyst/Executor/Reviewer/KK/PostEval 等）共用此入口。
 */
import { skillLoader, type SkillTier } from '@dommaker/studio-skill';
import { buildAgentConstraintPrompt } from '@dommaker/studio-shared/harness/hooks';

export interface AgentContextOptions {
  /** Agent 角色类型（影响 skill/knowledge 过滤） */
  agentType?: string;
  /** 模型 tier（影响 skill 选择） */
  tier?: SkillTier;
  /** 具体操作类型（用于 harness 约束） */
  operation?: string;
  /** 任务描述（用于 harness 约束） */
  taskDescription?: string;
  /** 紧凑模式：只返回摘要，不返回完整 prompt 文本 */
  compact?: boolean;
}

export interface AgentContext {
  /** 完整的 prompt 注入文本 */
  prompt: string;
  /** 各部分摘要 */
  summary: {
    skills: number;
    knowledge: boolean;
    harness: boolean;
    roles: boolean;
  };
}

/**
 * 构建 Agent 上下文
 *
 * 聚合顺序：
 *   1. Harness 约束（Iron Laws + Guidelines）
 *   2. Skill 注入（按 trigger + agentType + tier）
 *   3. 知识上下文（偏好/规则/环境/决策链/模式）— 延迟加载
 *   4. 知识总线（Agent 间共享）
 */
export function buildAgentContext(options: AgentContextOptions = {}): AgentContext {
  const {
    agentType = 'executor',
    tier = 'standard',
    operation = 'code_implementation',
    taskDescription = '',
    compact = false,
  } = options;

  // 1. Harness 约束
  let harnessPrompt = '';
  try {
    harnessPrompt = buildAgentConstraintPrompt({
      operation: operation as any,
      taskDescription,
    });
  } catch { /* harness may not be initialized */ }

  // 2. Skill 注入（元数据+索引模式：只注入索引，Agent 按需通过 loadSkill MCP tool 加载完整内容）
  let skillPrompt = '';
  let skillCount = 0;
  try {
    const skills = skillLoader.load({
      agentType,
      tier,
    });
    skillCount = skills.length;
    const skillIndex = skillLoader.formatForPrompt(skills);
    if (skillIndex) {
      skillPrompt = [
        '## Available Skills',
        '以下 skill 可用。需要时使用 `loadSkill` MCP tool 加载完整内容。',
        '',
        skillIndex,
      ].join('\n');
    }
  } catch { /* best-effort */ }

  // 3. Knowledge — deferred import to avoid circular deps
  // In compact mode, skip knowledge loading
  let knowledgeAvailable = false;

  // 4. KnowledgeBus context — also deferred
  let busContext = '';

  if (compact) {
    // Compact mode: build summary only
    const promptParts = [harnessPrompt, skillPrompt].filter(Boolean);
    return {
      prompt: promptParts.join('\n\n---\n\n'),
      summary: {
        skills: skillCount,
        knowledge: knowledgeAvailable,
        harness: !!harnessPrompt,
        roles: false,
      },
    };
  }

  // Full mode — async loading not possible in sync function,
  // return what's available synchronously (harness + skills).
  // Callers should also call buildKnowledgeContext() separately.
  const promptParts = [harnessPrompt, skillPrompt].filter(Boolean);

  return {
    prompt: promptParts.join('\n\n---\n\n'),
    summary: {
      skills: skillCount,
      knowledge: knowledgeAvailable,
      harness: !!harnessPrompt,
      roles: false,
    },
  };
}


