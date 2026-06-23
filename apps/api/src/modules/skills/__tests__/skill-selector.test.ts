/**
 * skill-selector tests (AS-025 §3.28c-5)
 *
 * AC2: 根据 scope 匹配 Skill（关键词匹配）
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { selectSkills } from '../skill-selector.js';
import type { SkillEntry } from '../manifest-loader.js';

const SKILLS: SkillEntry[] = [
  { name: 'session-analyst', path: 'session-analyst/SKILL.md', question: '如何分析需求产出 spec 或 SDD' },
  { name: 'tdd-red', path: 'tdd-red/SKILL.md', question: '如何设计测试契约（RED 阶段方法论）' },
  { name: 'tdd-green', path: 'tdd-green/SKILL.md', question: '如何用最小代码让测试通过（GREEN 阶段）' },
  { name: 'code-review', path: 'code-review/SKILL.md', question: '如何多维度审查代码质量' },
  { name: 'arch-review-skill', path: 'arch-review-skill/SKILL.md', question: '概念完整性如何' },
  { name: 'sdd-review-skill', path: 'sdd-review-skill/SKILL.md', question: '这个设计质量如何（三层一致性）' },
  { name: 'spec-review-skill', path: 'spec-review-skill/SKILL.md', question: '这个 spec 可执行吗' },
  { name: 'knowledge-extraction', path: 'knowledge-extraction/SKILL.md', question: '如何从事件提取知识' },
  { name: 'knowledge-synthesis-skill', path: 'knowledge-synthesis-skill/SKILL.md', question: '如何跨时间窗口综合模式' },
  { name: 'knowledge-quality-skill', path: 'knowledge-quality-skill/SKILL.md', question: '知识库健康度如何（语义层审计）' },
  { name: 'doc-manager-skill', path: 'doc-manager-skill/SKILL.md', question: '如何管理结构化文档（保存进度/创建 spec/更新文档/更新 roadmap）' },
];

describe('skill-selector', () => {
  describe('AC2: selectSkills matches scope to skills', () => {
    it('"分析需求" → session-analyst', () => {
      const result = selectSkills('分析需求：用户认证模块', SKILLS);
      expect(result.map(s => s.name)).toContain('session-analyst');
    });

    it('"代码审查" → code-review', () => {
      const result = selectSkills('代码审查 PR #123', SKILLS);
      expect(result.map(s => s.name)).toContain('code-review');
    });

    it('"测试契约" → tdd-red', () => {
      const result = selectSkills('设计测试契约，RED 阶段', SKILLS);
      expect(result.map(s => s.name)).toContain('tdd-red');
    });

    it('"最小实现" → tdd-green', () => {
      const result = selectSkills('最小实现让测试通过', SKILLS);
      expect(result.map(s => s.name)).toContain('tdd-green');
    });

    it('"架构审查" → arch-review-skill', () => {
      const result = selectSkills('架构审查：概念完整性检查', SKILLS);
      expect(result.map(s => s.name)).toContain('arch-review-skill');
    });

    it('"设计质量" → sdd-review-skill', () => {
      const result = selectSkills('评估这个设计质量（三层一致性）', SKILLS);
      expect(result.map(s => s.name)).toContain('sdd-review-skill');
    });

    it('"知识提取" → knowledge-extraction', () => {
      const result = selectSkills('从事件提取知识', SKILLS);
      expect(result.map(s => s.name)).toContain('knowledge-extraction');
    });

    it('"知识库健康度" → knowledge-quality-skill', () => {
      const result = selectSkills('检查知识库健康度', SKILLS);
      expect(result.map(s => s.name)).toContain('knowledge-quality-skill');
    });

    it('"更新 roadmap" → doc-manager-skill', () => {
      const result = selectSkills('更新 roadmap 和 spec', SKILLS);
      expect(result.map(s => s.name)).toContain('doc-manager-skill');
    });

    it('case-insensitive matching', () => {
      const result = selectSkills('CODE REVIEW this PR', SKILLS);
      expect(result.map(s => s.name)).toContain('code-review');
    });

    it('matches multiple skills for composite scope', () => {
      const result = selectSkills('分析需求并设计测试契约', SKILLS);
      const names = result.map(s => s.name);
      expect(names).toContain('session-analyst');
      expect(names).toContain('tdd-red');
    });

    it('returns empty array when no match', () => {
      const result = selectSkills('随便写点什么无关的内容', SKILLS);
      expect(result).toEqual([]);
    });

    it('returns empty array for empty scope', () => {
      const result = selectSkills('', SKILLS);
      expect(result).toEqual([]);
    });
  });
});
