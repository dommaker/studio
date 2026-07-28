/**
 * skill-selector tests (AS-025 §3.28c-5)
 *
 * AC2: 根据 scope 匹配 Skill（description 匹配）
 */
import { describe, it, expect, vi } from 'vitest';

// importOriginal：skill-selector 还依赖 normalizeToStage，不能整包替换
vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

import { selectSkills } from '../skill-selector.js';
import type { SkillEntry } from '../manifest-loader.js';

const SKILLS: SkillEntry[] = [
  { name: 'session-analyst', path: 'session-analyst/SKILL.md', description: '分析需求、需求分析、产出 spec/SDD、AC 形式化、用户故事验收标准' },
  { name: 'tdd-red', path: 'tdd-red/SKILL.md', description: '测试契约设计、RED 阶段、FAIL 测试、AC 转测试' },
  { name: 'tdd-green', path: 'tdd-green/SKILL.md', description: '最小实现、GREEN 阶段、让测试通过、最小代码' },
  { name: 'code-review', path: 'code-review/SKILL.md', description: '代码审查、多维度质量检查、AC 覆盖、安全审查' },
  { name: 'arch-review-skill', path: 'arch-review-skill/SKILL.md', description: '架构审查、概念完整性、维度覆盖检查' },
  { name: 'sdd-review-skill', path: 'sdd-review-skill/SKILL.md', description: 'SDD 审查、设计质量、三层一致性、AC Group 验证' },
  { name: 'spec-review-skill', path: 'spec-review-skill/SKILL.md', description: 'spec 审查、可执行性检查、AC 可测试性' },
  { name: 'knowledge-extraction', path: 'knowledge-extraction/SKILL.md', description: '知识提取、从事件提取可复用知识' },
  { name: 'knowledge-synthesis-skill', path: 'knowledge-synthesis-skill/SKILL.md', description: '知识综合、跨时间窗口模式识别' },
  { name: 'knowledge-quality-skill', path: 'knowledge-quality-skill/SKILL.md', description: '知识库健康度、语义层审计、知识质量审查' },
  { name: 'doc-manager-skill', path: 'doc-manager-skill/SKILL.md', description: '文档管理、保存进度、创建 spec、更新 roadmap' },
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

    it('"spec 审查" → spec-review-skill', () => {
      const result = selectSkills('审查这个 spec 的可执行性', SKILLS);
      expect(result.map(s => s.name)).toContain('spec-review-skill');
    });

    it('"SDD 审查" → sdd-review-skill', () => {
      const result = selectSkills('SDD 审查：检查三层一致性', SKILLS);
      expect(result.map(s => s.name)).toContain('sdd-review-skill');
    });

    it('"知识综合" → knowledge-synthesis-skill', () => {
      const result = selectSkills('跨时间窗口综合模式', SKILLS);
      expect(result.map(s => s.name)).toContain('knowledge-synthesis-skill');
    });
  });
});
