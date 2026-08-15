---
id: "cmq9s9a5y005cagplxu7nxihi"
goalId: "cmq9s9cb40067agplsseker44"
slug: "p6-workflow-skills-req-impl-review-skill"
title: "P6 Workflow Skills: /req + /impl + /review 三个核心工作流 Skill"
status: "stale"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["P6", "workflow-skills", "skill-md", "pipeline", "prompt-engineering"]
createdAt: "2026-06-11T17:40:08.753Z"
updatedAt: "2026-06-11T17:40:11.607Z"
---

# P6 Workflow Skills: /req + /impl + /review 三个核心工作流 Skill

增强现有 3 个 SKILL.md 骨架文件为完整的标准化工作流 prompt 模板，覆盖需求分析(5步)、TDD实现(8步)、代码审查(pass/gap/issue)三个核心流程

<!-- TASK_TIER {"tier":"standard","reason":"3 个 SKILL.md 文件分布在 2 个 trigger 目录（goal-start/、review/），内容复杂度高（每个 100-200 行工作流定义），但无代码改动、无 schema 变更"} -->

## Architecture Context

### req-skill-enhancement

**Functions**
- skillLoader.load({ trigger: 'goal_start', agentType: 'analyst' }) @ packages/studio-skill/src/loader.ts:L68
- buildAnalystPrompt(requirement, knowledge, accuracyReflection, outputFile, preClassifiedTier?, availableRepos?) @ analyst-prompt.ts:L18
- loadSkillTemplate(skillName): SkillTemplate | null @ scheduler-prompt.ts:L38
- buildSkillPrompt(skillName, vars): string @ scheduler-prompt.ts:L86

**Call Chain**
analyst-trigger.service.ts::trigger() → buildAnalystPrompt() → skillLoader.load({trigger:'goal_start', agentType:'analyst'}) → SKILL.md body injected into prompt → Claude Code agent executes workflow steps

**Types in Scope**
- AcGroup { id, acs, files, dependencies, implementationNotes?, codePatterns?, gotchas?, modelTier?, modelTierReason? } @ pipeline-utils.ts:L19-L29
- RequirementsDocJson { title, summary, tier, acGroups, contractTests, ... } @ analyst-executor.ts

**Danger Zones**
- frontmatter 的 name/trigger/agentTypes/tier 字段不可修改——它们决定 skill 何时被加载
- 保留 {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}} 占位符——buildSkillPrompt() 依赖它们
- body 中的 YAML frontmatter 分隔符 --- 不可出现在 body 内容中（会破坏解析）

### impl-skill-enhancement

**Functions**
- skillLoader.load({ trigger: 'goal_start', agentType: 'executor' }) @ packages/studio-skill/src/loader.ts:L68
- buildSubAgentPrompt(input, siblingContext?, companyKnowledge?) @ scheduler-prompt.ts:L116
- resolveDependencies(acGroups: AcGroup[]): AcGroup[][] @ pipeline-utils.ts:L68
- routeModel(acGroup: AcGroup): { tier, reason } @ pipeline-utils.ts:L134
- grepACTests(acs: string[], dir: string): ACTestCoverage[] @ pipeline-utils.ts:L215

**Call Chain**
GoalScheduler.processGoal() → dispatchStep() → buildSubAgentPrompt() → buildSkillPrompt('sub-agent-workflow', vars) → agentRunner.execute()

**Types in Scope**
- AcGroup { id, acs, files, dependencies, modelTier? } @ pipeline-utils.ts:L19-L29
- ACTestCoverage { acId, testFile, matched } @ pipeline-utils.ts:L205-L209
- HarnessCheckResult { passed, errors } @ pipeline-utils.ts:L263-L266

**Danger Zones**
- frontmatter 的 name/trigger/agentTypes/tier 字段不可修改
- 保留 {{task}} 等占位符——buildSkillPrompt() 和 buildSubAgentPrompt() 依赖它们
- tier: fast 意味着 SkillLoaderService 的 tier rank 过滤会限制工具权限（fast 只有 Read/Glob/Grep/Bash）

### review-skill-enhancement

**Functions**
- SkillLoader.load({ trigger: 'review', agentType: 'reviewer' }) @ packages/studio-skill/src/loader.ts:L68
- handleGoalSucceeded(goalId): Promise<void> @ goal-review.ts:L52
- reviewAgent.reviewParallel() — 在 handleGoalSucceeded 中调用

**Call Chain**
checkGoalCompletion() → handleGoalSucceeded() → reviewAgent.reviewParallel() → skill loaded via SkillLoader({trigger:'review', agentType:'reviewer'})

**Types in Scope**
- ReviewResult { overallApproved, acCoverage, issues, suggestions } — 在 review SKILL.md 中定义输出格式

**Danger Zones**
- frontmatter 的 name/trigger/agentTypes/tier 字段不可修改
- 保留 {{task}} 等占位符
- review skill 在 integration 步骤完成后加载——审查对象是合并后的代码

## AC Groups

### req-skill-enhancement

#### 实现指南
1. 读取现有 SKILL.md，保留 frontmatter 不变。2. 重写 body 部分为结构化工作流。3. 每步格式：步骤名 → 门控检查 → 产出 → 通过条件。4. 参考 analyst-prompt.ts L78-L178 的工作流描述（修改点溯源步骤、CONTEXT.md 缓存、AC 结构化要求）。5. 参考 pipeline-utils.ts 的 AcGroup 接口（L19-L29）定义 spec.md 输出格式。6. 保留 {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}} 占位符在 body 末尾。

#### 参考模式
- ~/.studio/skills/goal-start/contract-test-writing/SKILL.md — 同级 skill，参考 frontmatter 格式和 body 结构
- analyst-prompt.ts:L78-L178 — 修改点溯源步骤、CONTEXT.md 缓存策略、AC 结构化要求
- pipeline-utils.ts:L19-L29 — AcGroup 接口定义，spec.md 输出格式参考

#### ⚠️ 注意事项
- ⚠️ 不可删除: {{task}} 等占位符 (消费者: buildSkillPrompt() @ scheduler-prompt.ts:L86)
- ⚠️ 不可修改: frontmatter 字段 (消费者: skillLoader.load() 过滤逻辑)
- ⚠️ body 中避免使用 --- 分隔符 (会破坏 YAML frontmatter 解析器 @ loader.ts:L48)

### impl-skill-enhancement

#### 实现指南
1. 读取现有 SKILL.md，保留 frontmatter 不变。2. 重写 body 为 8 步 TDD 工作流。3. 参考 green-only-tdd skill (goal-start/green-only-tdd/SKILL.md) 的 TDD 流程。4. 参考 scheduler-queue.ts 的 modelTier 路由逻辑（L106-110: acGroup.modelTier 优先）。5. 参考 pipeline-utils.ts 的 resolveDependencies() (L68-124) 拓扑排序逻辑。6. 保留 {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}} 占位符。

#### 参考模式
- ~/.studio/skills/goal-start/green-only-tdd/SKILL.md — TDD 流程参考
- pipeline-utils.ts:L68-L124 — resolveDependencies 拓扑排序
- pipeline-utils.ts:L134-L164 — routeModel tier 路由
- scheduler-queue.ts:L106-L110 — acGroup.modelTier 优先级逻辑

#### ⚠️ 注意事项
- ⚠️ 不可删除: {{task}} 等占位符 (消费者: buildSkillPrompt())
- ⚠️ 不可修改: frontmatter tier:fast (影响 SkillLoaderService tier rank 过滤)
- ⚠️ impl skill 的 tier:fast 意味着 executor 只有 Read/Glob/Grep/Bash 工具——TDD RED 阶段需要 Write/Edit 但 fast tier 不允许 (已有 green-only-tdd skill 也是 fast tier，说明 executor 实际工具权限由 agentRunner 控制，不受 skill tier 限制)

### review-skill-enhancement

#### 实现指南
1. 读取现有 SKILL.md，保留 frontmatter 不变。2. 重写 body 为结构化审查流程。3. 参考 multi-stance-review 和 forensic-review skill 的审查维度。4. 参考 goal-review.ts L52 的 reviewAgent.reviewParallel() 调用模式。5. 输出格式对齐 goal-review.ts 的审查结论结构。6. 保留 {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}} 占位符。

#### 参考模式
- ~/.studio/skills/review/multi-stance-review/SKILL.md — 多立场审查维度参考
- ~/.studio/skills/review/forensic-review/SKILL.md — 法证审查模式参考
- goal-review.ts:L52 — handleGoalSucceeded 审查流程

#### ⚠️ 注意事项
- ⚠️ 不可删除: {{task}} 等占位符 (消费者: buildSkillPrompt())
- ⚠️ 不可修改: frontmatter trigger:review (决定 skill 何时被加载)
- ⚠️ review skill 在 integration 步骤后加载——审查的是合并后的工作树代码，不是单个 acGroup 的改动