/**
 * skill-selector (AS-025 §3.28c-5)
 *
 * Keyword-based skill matching for WorkUnit scope.
 * No LLM — pure code-driven matching.
 *
 * AC2: 根据 scope 匹配 Skill
 */
import type { SkillEntry } from './manifest-loader.js';

/**
 * Keyword map: skillName → keywords that trigger this skill.
 * Matching is case-insensitive, substring-based.
 */
const KEYWORD_MAP: Record<string, string[]> = {
  // 原子 Skill
  'session-analyst': ['分析需求', '需求分析', '产出 spec', '产出 sdd', '写 spec', '写 sdd'],
  'tdd-red': ['测试契约', '测试设计', 'red 阶段', 'red阶段', '设计测试'],
  'tdd-green': ['最小实现', 'green 阶段', 'green阶段', '测试通过', '最小代码'],
  'code-review': ['代码审查', '审查代码', 'code review', '审查 pr'],

  // 文档质量
  'arch-review-skill': ['架构审查', '概念完整性'],
  'sdd-review-skill': ['设计质量', '三层一致性', 'sdd 审查', '设计审查'],
  'spec-review-skill': ['spec 可执行', 'spec 审查', '审查 spec'],

  // 知识引擎
  'knowledge-extraction': ['提取知识', '知识提取', '事件提取'],
  'knowledge-synthesis-skill': ['综合模式', '跨时间窗口', '知识综合'],
  'knowledge-quality-skill': ['知识库健康', '健康度', '语义层审计', '知识审计'],
  'doc-manager-skill': ['管理文档', '更新 roadmap', '保存进度', '创建 spec', '更新文档'],
};

/**
 * Select skills matching the given scope text.
 * Returns entries whose keywords appear in scope (case-insensitive).
 */
export function selectSkills(scope: string, skills: SkillEntry[]): SkillEntry[] {
  if (!scope) return [];

  const scopeLower = scope.toLowerCase();

  return skills.filter(skill => {
    const keywords = KEYWORD_MAP[skill.name];
    if (!keywords) return false;
    return keywords.some(kw => scopeLower.includes(kw.toLowerCase()));
  });
}
