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

// All skills with real descriptions (from SKILL.md frontmatter)
const ALL_SKILLS: SkillEntry[] = [
  { name: 'arch-review-skill', path: 'arch-review-skill/SKILL.md', description: '对照 arch-patterns 知识库检查架构文档的概念完整性和覆盖度。验证每个概念满足所有必要维度（生命周期、事件、交互方、验证标准），识别缺口。用于：检查架构文档（pipeline、agent-network）的概念定义、验证概念覆盖度、评估必要维度覆盖、发现 P0/P1 缺口。不用于审查 SDD 三层文档（用 sdd-review-skill）、审查 spec 质量（用 spec-review-skill）、或检查知识条目质量（用 knowledge-quality-skill）。' },
  { name: 'code-review', path: 'code-review/SKILL.md', description: '代码审查、审查代码、代码质量审查。实现完成且测试通过后，对代码执行多维度质量检查。检查：AC 覆盖（每条标准有实现+测试）、代码质量（可读性/可维护性）、架构一致性（匹配设计文档）、安全性（OWASP）、边界情况。不用于实现功能（用 tdd-implement）、分析需求（用 design-analyst）、或审查 spec 质量（用 spec-review-skill）。' },
  { name: 'design-analyst', path: 'design-analyst/SKILL.md', description: '需求分析、brainstorming、设计探索、需求澄清、方案对比、产出设计文档。把模糊需求变成结构化设计文档（含方案对比、AC 定义、实施路径）。覆盖：需要澄清的模糊需求、需要架构探索的功能请求、缺乏明确设计方案的任务。不用于审查已有 spec 或设计文档（用 spec-review-skill）、编写 SDD 三层文档（用 to-tickets）、实现代码（用 tdd-implement）、审查代码质量（用 code-review）。' },
  { name: 'doc-manager-skill', path: 'doc-manager-skill/SKILL.md', description: "当用户要求保存进度、创建 spec 文档、更新现有文档或更新 roadmap 时使用。处理四种操作：save-progress（批量进度写入 memory）、create-spec（带 dependencies frontmatter 的结构化 spec）、update-doc（修改现有文档并保持格式）、update-roadmap（更新 Phase 状态）。触发词：'保存进度'、'记录进展'、'写 spec'、'创建设计文档'、'更新文档'、'修改文档'、'更新 roadmap'、'更新 Phase'、'保存到 memory'。不用于审查文档质量（用 sdd-review-skill 或 spec-review-skill），从工作中提取知识（用 knowledge-extraction），或分析需求（用 session-analyst）。" },
  { name: 'knowledge-extraction', path: 'knowledge-extraction/SKILL.md', description: '知识提取、提取知识、从近期工作产物中提取可复用知识，写入 ~/.studio/knowledge/。Loop-trigger（每日自动执行）：扫描 batch progress、session memory、分析文档，识别提取机会，去重后写入知识条目。自动触发，不需要用户请求。也支持 User-trigger：用户说"提取知识"或"沉淀知识"时从当前任务结果提取。不用于审查已有条目质量（用 knowledge-quality-skill）、检查格式合规（用 harness knowledge audit）、或管理生命周期（用 harness knowledge health）。' },
  { name: 'knowledge-quality-skill', path: 'knowledge-quality-skill/SKILL.md', description: '知识库健康度审查、知识质量审查、当需要审查 ~/.studio/knowledge/ 中知识条目的语义质量时使用。检查条目是否按类型具备完整内容——guideline 需有适用场景和反例，architecture 需有权衡分析，decision 需有理由，pitfall 需有根因。评估内容价值（可操作知识 vs 事件噪音），检测跨条目矛盾，验证代码引用存活，查找语义重复，校验格式一致性。不用于纯格式校验（用 harness knowledge audit），从工作中提取新知识（用 knowledge-extraction），综合跨条目模式（用 knowledge-synthesis-skill），或管理文档（用 doc-manager-skill）。' },
  { name: 'knowledge-synthesis-skill', path: 'knowledge-synthesis-skill/SKILL.md', description: 'Loop-trigger（每日/每周自动）：从时间窗口的知识集合中产出高阶洞察。两个子任务：(1) 语义模式检测——跨 type 聚类知识条目，发现 ≥3 条共享底层模式的聚类 → 提议新 skill；(2) 经验教训综合——识别跨主题关联 → 产出可操作经验总结。输入面向 Agent Network 核心实体（Knowledge Store / Channel / Event / WorkUnit）。不用于单条目质量审查（用 knowledge-quality-skill），单事件提取（用 knowledge-extraction-skill），或格式合规（用 harness knowledge audit）。' },
  { name: 'parallel-execution', path: 'parallel-execution/SKILL.md', description: '并行执行、多任务并行、当有多个独立任务需要执行时使用——升级文件、运行评估、创建 spec、诊断问题或任何批量操作。为每个任务分配独立 agent，收集结果，完成后汇报。可在当前会话通过 Agent tool 执行，或在 Agent Network 通过 WorkUnit/Claim 执行。不用于单任务（直接做）、共享文件的紧耦合任务（顺序执行），或需要步骤间人工介入的任务（先用 session-analyst 做需求分析）。' },
  { name: 'sdd-review-skill', path: 'sdd-review-skill/SKILL.md', description: 'SDD 审查、SDD 质量审查、设计审查、审查 SDD 质量和 AC Group 验证。对 requirement.md、design.md、task.md 执行全面检查：AC Group 与设计实现的对齐、每组 AC 的契约测试覆盖、三层状态一致性、代码变更漂移审查。支持完整 SDD 审计和定向验证。不用于审查 spec 文档（用 spec-review-skill）、检查架构概念完整性（用 arch-review-skill）、提取知识（用 knowledge-extraction）、或管理文档（用 doc-manager-skill）。' },
  { name: 'spec-review-skill', path: 'spec-review-skill/SKILL.md', description: '审查、审计、评估 studio/docs/specs/ 中 spec 文档的质量。触发场景：检查 spec 状态是否准确（如识别已实现但仍标记为 draft 的 spec）、评估是否具备启动 SDD 的就绪度（如验证数据模型、API、边界情况是否已定义）、发现模糊或不可测试的验收标准（AC）、验证交叉引用的有效性和结构完整性。确保 spec 可执行且正确反映实际进度。支持批量目录审查、单个 spec 审计、就绪度评估。不用于分析 spec 间的依赖图或架构拓扑（用 arch-review-skill）、审查 SDD 三层文档（用 sdd-review-skill）、或评估知识条目（用 knowledge-quality-skill）。' },
  { name: 'to-tickets', path: 'to-tickets/SKILL.md', description: '拆单、拆任务、把 spec/需求结论拆成 tracer-bullet 子工单（用户视角端到端行为 + AC + Blocked by），每票纵切全层、可独立交付验证，声明阻塞关系与可并行认领的 frontier；发布到工单系统，不产 task.md 等任何文件。wide refactor 走 expand-contract，拆单结果人审粒度。不用于需求澄清与方案设计（用 requirement-clarify）、实现代码（用 tdd-implement）、审查代码（用 code-review）。' },
  { name: 'tdd-implement', path: 'tdd-implement/SKILL.md', description: '按 SDD 实现代码、写 FAIL 测试、让测试通过、TDD 实现。读取 SDD，按 AC 写 FAIL 测试（RED），再按设计实现代码让测试通过（GREEN）。支持并行实现独立文件、增量类型检查。覆盖：有完整 SDD 的功能实现、需要 TDD 流程的编码任务。不用于分析需求（用 design-analyst）、规划任务（用 to-tickets）、审查代码（用 code-review）、审查 SDD 三层文档（用 sdd-review-skill）、或并行执行非实现任务（用 parallel-execution）。' },
  { name: 'test-diagnosis', path: 'test-diagnosis/SKILL.md', description: '当测试失败需要诊断根因时使用。区分三层问题：环境问题（vitest/jsdom/ECONNREFUSED/端口冲突）、依赖问题（vi.mock/外部服务/模块解析）、代码问题（超时/状态泄漏/fixture 污染）。当根因不明时提供系统化 fallback 诊断。不用于编写新测试（用 tdd-red），让失败测试通过（用 tdd-green），审查代码质量（用 code-review），或检查 spec 质量（用 spec-review-skill）。' },
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
  const skillsToEval = ['to-tickets', 'tdd-implement'];

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
