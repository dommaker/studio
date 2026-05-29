/**
 * buildAgentContext — 统一 Agent 上下文构建器
 *
 * 将 Skill、Knowledge、Harness 约束、角色约束 组装为单一 prompt 注入块。
 * 所有 Agent 类型（Analyst/Executor/Reviewer/KK/PostEval 等）共用此入口。
 */
import { skillLoader, type SkillTrigger, type SkillTier } from '@dommaker/studio-skill';
import { buildAgentConstraintPrompt } from '@dommaker/studio-shared/harness/hooks';

export interface AgentContextOptions {
  /** Agent 角色类型（影响 skill/knowledge 过滤） */
  agentType?: string;
  /** 触发场景（goal_start | goal_continue | review | triage | post_eval | 等） */
  trigger?: string;
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
    trigger = 'goal_start',
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

  // 2. Skill 注入
  let skillPrompt = '';
  let skillCount = 0;
  try {
    const skills = skillLoader.load({
      trigger: trigger as SkillTrigger,
      agentType,
      tier,
    });
    skillCount = skills.length;
    skillPrompt = skillLoader.formatForPrompt(skills);
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
  // Callers should also call knowledgeQuery.formatCompactForPrompt() separately.
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

/**
 * 异步扩展：加载知识上下文和角色约束
 * 调用方在 async 上下文中使用此方法获取完整 prompt
 *
 * @deprecated KE-002 P4: 无调用方。Agent 直接用 getRecentContext() + formatAllForPrompt()。
 * 保留供未来统一入口参考。
 */
export async function buildAgentContextAsync(options: AgentContextOptions = {}): Promise<AgentContext> {
  const base = buildAgentContext({ ...options, compact: true });
  const { agentType = 'executor' } = options;

  let knowledgePrompt = '';

  // 知识上下文
  try {
    const { knowledgeQuery } = await import('../knowledge/knowledge-query.service.js');
    knowledgePrompt = await knowledgeQuery.formatCompactForPrompt(agentType);
  } catch { /* best-effort */ }

  // 知识总线
  let busPrompt = '';
  try {
    const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
    busPrompt = knowledgeBus.getRecentContext(agentType, 5);
  } catch { /* best-effort */ }

  const allParts = [base.prompt, knowledgePrompt, busPrompt].filter(Boolean);

  return {
    prompt: allParts.join('\n\n---\n\n'),
    summary: {
      skills: base.summary.skills,
      knowledge: !!knowledgePrompt,
      harness: base.summary.harness,
      roles: false,
    },
  };
}
