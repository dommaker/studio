/**
 * Trigger Eval — Skill Discovery precision test
 *
 * Tests that selectSkills() correctly triggers (or doesn't trigger)
 * for each skill's trigger-eval.json queries.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { selectSkills } from '../skill-selector.js';
import type { SkillEntry } from '../manifest-loader.js';

// All active skills with real descriptions (from SKILL.md frontmatter).
// 与 ~/.studio/skills/MANIFEST.md Active Skills 对齐（15 个）；退役 skill 不入池（#224 起删正本留 git 史，无 _deprecated 残留）。
// 注：to-tickets 保留扩展版描述——frontmatter 的 triggers（拆任务/独立交付/并行认领等）
// 在生产环境参与匹配，fixture 不载 triggers 字段，扩展描述用于等价覆盖这些触发面。
const ALL_SKILLS: SkillEntry[] = [
  { name: 'arch-review-skill', path: 'arch-review-skill/SKILL.md', description: '对照 arch-patterns 知识库检查架构文档的概念完整性和覆盖度，识别 P0/P1 缺口。' },
  { name: 'code-review', path: 'code-review/SKILL.md', description: '对实现分支的 diff 执行两轴审查——契约轴（代码是否兑现工单 issue/AC）与规范轴（是否符合仓内标准与气味基线），两轴并列报告不合并定级。' },
  { name: 'dead-code-removal', path: 'dead-code-removal/SKILL.md', description: '彻底清理已废弃的代码概念：跨 schema、后端、前端、packages 全链路删除。' },
  { name: 'exploration-sediment', path: 'exploration-sediment/SKILL.md', description: '调研/探索结论沉淀：把本轮调研的耐久发现写入对应源码目录的 CONTEXT.md（注意事项/核心导出），避免下个会话重复探索。' },
  { name: 'knowledge-extraction', path: 'knowledge-extraction/SKILL.md', description: '从近期工作产物中提取可复用知识，去重后写入知识库（Loop 自动触发，也支持用户请求）。' },
  { name: 'knowledge-quality-skill', path: 'knowledge-quality-skill/SKILL.md', description: '审查知识库条目的语义质量：内容完整性、价值、跨条目矛盾、引用存活、语义重复。' },
  { name: 'knowledge-synthesis-skill', path: 'knowledge-synthesis-skill/SKILL.md', description: '从时间窗口的知识集合中产出高阶洞察：语义模式检测与经验教训综合（Loop 自动触发）。' },
  { name: 'migration-execution-skill', path: 'migration-execution-skill/SKILL.md', description: '执行大规模、跨文件的代码库增量迁移（Round 分解 → 转换 → 验证 → 级联修复）。' },
  { name: 'parallel-execution', path: 'parallel-execution/SKILL.md', description: '多个独立任务并行执行：为每个任务分配独立 agent，收集结果并汇总汇报。' },
  { name: 'prototype', path: 'prototype/SKILL.md', description: 'analysis 工单原型方法论：仅用于纸面裁不动的设计问题——造一次性代码回答「逻辑/状态模型跑起来对不对」或「UI 该长什么样」，代码落 prototype/<name> 一次性分支（不合并、不进评审），结论（回答了什么问题）记录回来源工单。不用于生产实现（用 tdd-implement）、仓外事实调研（用 research）、纸面能裁的问题（直接决策，别造代码）。' },
  { name: 'requirement-clarify', path: 'requirement-clarify/SKILL.md', description: '位1 主方法论：模糊需求多轮澄清（每轮 1-3 个关键问题+建议答案）→ 有设计空间时做方案对比/详细设计/AC 定义/风险评估 → spec 落业务仓 .studio/specs/ 过位2 就绪度质量门 → 路由拆单。' },
  { name: 'research', path: 'research/SKILL.md', description: 'analysis 工单调研方法论：针对待决问题查高可信一手来源（官方文档/源码/spec/一方 API，不抄二手转述），调研报告落业务仓 .studio/research/ 并回挂来源工单链接。阅读外包给后台 agent，主会话继续推进。不用于需求澄清（用 requirement-clarify）、结论沉淀进 CONTEXT（用 exploration-sediment）、纸面裁不动的设计问题（用 prototype）。' },
  { name: 'tdd-implement', path: 'tdd-implement/SKILL.md', description: '按工单 AC 以 TDD 实现代码：先写 FAIL 测试（RED），再实现让测试通过（GREEN），Phase 提交。' },
  { name: 'test-diagnosis', path: 'test-diagnosis/SKILL.md', description: '测试失败时诊断根因：区分环境问题、依赖问题、代码问题三层，提供系统化 fallback 排查。' },
  { name: 'to-tickets', path: 'to-tickets/SKILL.md', description: '拆单、拆任务、把 spec/需求结论拆成 tracer-bullet 子工单（用户视角端到端行为 + AC + Blocked by），每票纵切全层、可独立交付验证，声明阻塞关系与可并行认领的 frontier；发布到工单系统，不产 task.md 等任何文件。wide refactor 走 expand-contract，拆单结果人审粒度。不用于需求澄清与方案设计（用 requirement-clarify）、实现代码（用 tdd-implement）、审查代码（用 code-review）。' },
];

const SKILLS_DIR = path.join(process.env.HOME || '/root', '.studio', 'skills');

interface TriggerEvalCase {
  query: string;
  should_trigger: boolean;
}

function loadTriggerEval(skillName: string): TriggerEvalCase[] {
  const filePath = path.join(SKILLS_DIR, skillName, 'evals', 'trigger-eval.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function runTriggerEval(targetSkill: string, cases: TriggerEvalCase[]) {
  let falsePositives: string[] = [];
  let falseNegatives: string[] = [];

  for (const { query, should_trigger } of cases) {
    const matched = selectSkills(query, ALL_SKILLS);
    const isMatched = matched.some(s => s.name === targetSkill);

    if (should_trigger && !isMatched) {
      falseNegatives.push(`  FN: "${query}" → should trigger ${targetSkill} but didn't. Matched: [${matched.map(s => s.name).join(', ')}]`);
    }
    if (!should_trigger && isMatched) {
      falsePositives.push(`  FP: "${query}" → should NOT trigger ${targetSkill} but did`);
    }
  }

  return { falsePositives, falseNegatives };
}

describe('trigger-eval: Skill Discovery precision', () => {
  const skillsToEval = ['to-tickets', 'tdd-implement', 'requirement-clarify'];

  for (const skillName of skillsToEval) {
    describe(skillName, () => {
      const cases = loadTriggerEval(skillName);
      const shouldTrigger = cases.filter(c => c.should_trigger);
      const shouldNotTrigger = cases.filter(c => !c.should_trigger);

      it(`should-trigger: all ${shouldTrigger.length} queries match`, () => {
        const { falseNegatives } = runTriggerEval(skillName, shouldTrigger);
        if (falseNegatives.length > 0) {
          console.log(`\n${skillName} false negatives:\n${falseNegatives.join('\n')}`);
        }
        expect(falseNegatives).toEqual([]);
      });

      it(`should-NOT-trigger: all ${shouldNotTrigger.length} queries excluded`, () => {
        const { falsePositives } = runTriggerEval(skillName, shouldNotTrigger);
        if (falsePositives.length > 0) {
          console.log(`\n${skillName} false positives:\n${falsePositives.join('\n')}`);
        }
        expect(falsePositives).toEqual([]);
      });
    });
  }
});
