/**
 * 9 个内置 Skill 定义
 *
 * 从 agent-executor.ts、goal-scheduler.ts、review-report.ts、
 * knowledge-agent.service.ts 中的硬编码 prompt 迁移而来。
 */

import type { SkillDefinition } from '../types.js';

// ── P0: 核心执行 Skills ──

export const tddWorkflow: SkillDefinition = {
  id: 'tdd-workflow',
  name: 'TDD Workflow',
  description: '测试驱动开发工作流：写失败测试→最小实现→通过→重构→循环',
  trigger: 'goal_start',
  agentTypes: ['executor'],
  tier: 'fast',
  prompt: `## TDD 工作流

严格按以下流程工作：

1. 读 AC → 写失败的测试
2. 运行测试确认失败
3. 最小实现让测试通过 → 运行确认通过
4. 重构优化
5. 重复 1-4 直到所有 AC 满足
6. 运行 npm test + type check + lint
7. 更新 .progress.json
8. 全部 AC 覆盖 + 全部测试通过 → 设置 .progress.json allComplete: true`,
};

export const stuckRecovery: SkillDefinition = {
  id: 'stuck-recovery',
  name: 'Stuck Recovery',
  description: '执行卡住时的逐级策略切换提示',
  trigger: 'goal_continue',
  agentTypes: ['executor'],
  tier: 'fast',
  prompt: '', // 动态内容：根据 stuckCount 选择策略
};

export const behaviourConstraints: SkillDefinition = {
  id: 'behaviour-constraints',
  name: 'Behaviour Constraints',
  description: 'Agent 行为约束：progress.json 更新、禁止模糊声明',
  trigger: 'always',
  agentTypes: ['executor'],
  tier: 'fast',
  prompt: `## 重要

- 每完成一个步骤后必须更新 .progress.json
- 如果没有 .progress.json 文件，立即创建
- 将环境变量 STUDIO_EXECUTION_ID 和 STUDIO_GOAL_ID（如有）写入 .progress.json.executionId 和 .progress.json.goalId
- 只在你真正完成时才设置 allComplete: true`,
};

// ── P1: 审查 + 知识 Skills ──

export const multiStanceReview: SkillDefinition = {
  id: 'multi-stance-review',
  name: 'Multi-Stance Review',
  description: '多立场代码审查：质疑者/架构师/执行者/实用主义者轮流审查',
  trigger: 'review',
  agentTypes: ['reviewer'],
  tier: 'standard',
  prompt: `## 审查流程

你要用 4 个立场轮流审查代码，每个立场关注不同的维度：

1. **质疑者 (skeptic)**: 寻找逻辑错误、边界条件遗漏、安全隐患
2. **架构师 (architect)**: 检查架构一致性、模块耦合、接口设计
3. **执行者 (executor)**: 评估代码可维护性、可读性、测试覆盖
4. **实用主义者 (pragmatist)**: 检查是否过度设计、是否有更简单方案

对每个立场：
- 检查 git diff 中的变更
- 运行 npm test 确认通过
- 逐条验证 AC
- 补充边界测试

审查结论：
- 全部通过 → overallApproved: true
- 有问题 → 列出具体问题和建议修改方案`,
};

export const knowledgeExtraction: SkillDefinition = {
  id: 'knowledge-extraction',
  name: 'Knowledge Extraction',
  description: '从执行结果提取知识：decision/pitfall/guideline/model',
  trigger: 'knowledge_extract',
  agentTypes: ['knowledge_keeper'],
  tier: 'standard',
  prompt: `## 知识提取

分析执行结果，提取可复用的知识：

1. **失败任务** → 重点提取 pitfall（踩坑记录）
2. **成功任务** → 提取 decision（设计决策）和 guideline（最佳实践）
3. **架构变更** → 提取 model（架构模式）

输出 JSON：
{
  "entries": [{
    "type": "decision" | "pitfall" | "guideline" | "model",
    "title": "简洁标题",
    "content": "详细内容",
    "tags": ["标签"],
    "importance": 1-5
  }]
}

最多 5 条，按重要性排序。`,
};

export const forensicReview: SkillDefinition = {
  id: 'forensic-review',
  name: 'Forensic Review',
  description: '第5立场审查：检测 fallback/hack/workaround/临时方案等技术债模式',
  trigger: 'review',
  agentTypes: ['reviewer'],
  tier: 'standard',
  prompt: `## 第5立场：法证审查 (Forensic)

在前4立场之后，用法证视角审查代码变更，专注检测：

1. **Fallback 模式**: try/catch 吞异常、|| 默认值掩盖错误、silent fail
2. **Hack/Workaround**: 注释含 HACK/FIXME/WORKAROUND/临时、硬编码魔数绕过逻辑
3. **降级伪装**: 用简单实现替代设计意图（如 curl 替代 e2e 测试、skip 替代修复）
4. **门禁绕过**: --no-verify、skip-ci、降阈值让 CI 通过、删测试让构建绿
5. **僵尸代码**: 被注释但未删除的代码块、unused import/variable 保留"以防万一"

对每个发现：
- 指出位置（文件:行号）
- 判断严重程度：critical（必须修）/ warning（建议修）/ info（记录）
- 提供正确修复方案

如果发现 critical 级别的 hack：overallApproved 必须为 false。`,
};

export const toolRisk: SkillDefinition = {
  id: 'tool-risk',
  name: 'Tool Risk Detection',
  description: '执行时检测危险工具调用模式：破坏性命令、权限提升、数据丢失',
  trigger: 'always',
  agentTypes: ['executor'],
  tier: 'fast',
  prompt: `## 工具风险检测

执行任务时自我检查，禁止以下危险模式：

**禁止执行：**
- rm -rf / git clean -fd（无确认的批量删除）
- git push --force / git reset --hard（不可逆操作）
- DROP TABLE / TRUNCATE（数据丢失）
- chmod 777 / chown root（权限放大）
- curl | sh / eval（远程代码执行）

**必须确认后执行：**
- 修改 .env / 配置文件（影响全局）
- 删除测试文件或 fixture
- 修改 CI/CD 配置
- 安装新的系统级依赖

**自检规则：**
- 每次使用 Bash 工具前，判断命令是否在禁止列表中
- 如果是，改用安全替代方案
- 如果无替代方案，在 .progress.json 中记录风险并停止该步骤`,
};

// ── P2: 集成 + 子 Agent Skills ──

export const integrationMerge: SkillDefinition = {
  id: 'integration-merge',
  name: 'Integration Merge',
  description: '集成验证：合并分支→typecheck→test→冲突分析',
  trigger: 'integration',
  agentTypes: ['executor'],
  tier: 'standard',
  prompt: `## 集成验证

你是集成验证者。合并所有并行 sub-agent 的工作并验证。

步骤：
1. 合并所有 task/* 分支
2. 运行 tsc --noEmit 检查类型
3. 运行 npm test 确认全部通过
4. 如果有冲突：分析根因，指出哪个 sub-agent 需要修改
5. 全部通过后设置 allComplete: true`,
};

export const subAgentWorkflow: SkillDefinition = {
  id: 'sub-agent-workflow',
  name: 'Sub-Agent Workflow',
  description: '子 Agent 执行时的 TDD 工作流（含文件路径和代码模式）',
  trigger: 'sub_agent',
  agentTypes: ['executor'],
  tier: 'fast',
  prompt: `## TDD 工作流

1. 读 AC → 写失败的测试
2. 运行测试确认失败
3. 最小实现让测试通过
4. 重构优化
5. 对所有 AC 重复
6. 运行 npm test + type check + lint
7. 更新 .progress.json（设置 allComplete: true 当且仅当所有 AC 满足）

完成后在 .progress.json 中记录：
- 做出的关键设计决策
- 需要跨步骤协调的事项`,
};

// ── 所有 Skills 列表 ──

export const allSkillDefinitions: SkillDefinition[] = [
  tddWorkflow,
  stuckRecovery,
  behaviourConstraints,
  multiStanceReview,
  forensicReview,
  knowledgeExtraction,
  integrationMerge,
  subAgentWorkflow,
  toolRisk,
];
