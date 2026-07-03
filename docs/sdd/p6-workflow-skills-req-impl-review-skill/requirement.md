---
id: "cmq9s9a5y005cagplxu7nxihi"
workUnitId: "cmq9s9cb40067agplsseker44"
slug: "p6-workflow-skills-req-impl-review-skill"
title: "P6 Workflow Skills: /req + /impl + /review 三个核心工作流 Skill"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["P6", "workflow-skills", "skill-md", "pipeline", "prompt-engineering"]
createdAt: "2026-06-11T17:40:08.753Z"
updatedAt: "2026-06-11T17:40:11.607Z"
---

# P6 Workflow Skills: /req + /impl + /review 三个核心工作流 Skill

增强现有 3 个 SKILL.md 骨架文件为完整的标准化工作流 prompt 模板，覆盖需求分析(5步)、TDD实现(8步)、代码审查(pass/gap/issue)三个核心流程

<!-- TASK_TIER {"tier":"standard","reason":"3 个 SKILL.md 文件分布在 2 个 trigger 目录（goal-start/、review/），内容复杂度高（每个 100-200 行工作流定义），但无代码改动、无 schema 变更"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["skillLoader.load({ trigger: 'goal_start', agentType: 'analyst' }) — packages/studio-skill/src/loader.ts:L68","skillLoader.load({ trigger: 'goal_start', agentType: 'executor' }) — packages/studio-skill/src/loader.ts:L68","SkillLoader.load({ trigger: 'review', agentType: 'reviewer' }) — packages/studio-skill/src/loader.ts:L68","loadSkillTemplate('req') — scheduler-prompt.ts:L38 searches SKILLS_DIR/<trigger>/req/SKILL.md","loadSkillTemplate('impl') — scheduler-prompt.ts:L38 searches SKILLS_DIR/<trigger>/impl/SKILL.md","buildSkillPrompt() — scheduler-prompt.ts:L86 replaces {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}}","SKILL.md frontmatter format — YAML between --- fences, fields: name/description/trigger/agentTypes/tier/status/version","Trigger normalization — directory uses hyphens (goal-start), frontmatter uses underscores (goal_start)"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ skillLoader.load({ trigger: 'goal_start', agentType: 'analyst' }) — packages/studio-skill/src/loader.ts:L68
- ✅ skillLoader.load({ trigger: 'goal_start', agentType: 'executor' }) — packages/studio-skill/src/loader.ts:L68
- ✅ SkillLoader.load({ trigger: 'review', agentType: 'reviewer' }) — packages/studio-skill/src/loader.ts:L68
- ✅ loadSkillTemplate('req') — scheduler-prompt.ts:L38 searches SKILLS_DIR/<trigger>/req/SKILL.md
- ✅ loadSkillTemplate('impl') — scheduler-prompt.ts:L38 searches SKILLS_DIR/<trigger>/impl/SKILL.md
- ✅ buildSkillPrompt() — scheduler-prompt.ts:L86 replaces {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}}
- ✅ SKILL.md frontmatter format — YAML between --- fences, fields: name/description/trigger/agentTypes/tier/status/version
- ✅ Trigger normalization — directory uses hyphens (goal-start), frontmatter uses underscores (goal_start)

## AC Groups

### req-skill-enhancement
<!-- MODEL_TIER {"tier":"standard","reason":"单文件但内容复杂（100+ 行工作流定义），需要理解 pipeline 架构和 analyst prompt 结构"} -->

#### 验收标准
- [ ] AC1.1: 在 ~/.studio/skills/goal-start/req/SKILL.md；重写 body 为 5 步工作流（CAPTURE→ANALYZE→ARCHITECTURE→DESIGN→SPEC）；每步包含门控检查描述（需求明确/第一性分析/方案已选/设计覆盖/AC质量门）；不修改 frontmatter（保留 name:requirement-analysis, trigger:goal_start, agentTypes:[analyst], tier:premium）
- [ ] AC1.2: 在 req/SKILL.md body 中定义产出格式；输出 docs/specs/{id}/ 下 4 个文件：requirements.md（需求文档）、architecture.md（架构决策）、design.md（设计文档）、spec.md（验收标准）；spec.md 包含 acGroups JSON 数组结构（id, acs, files, dependencies, modelTier）；不修改 pipeline 代码（产出格式由 agent prompt 引导）
- [ ] AC1.3: 在 req/SKILL.md body 中定义质量门规则；AC 可测试（有明确断言条件）、无歧义（动词开头）、文件覆盖（每条 AC 有 files）、依赖无环（拓扑排序可解）、全覆盖（需求→AC 1:1映射）、modelTier 合理（fast≤2AC≤3files, premium≥6AC或高风险）；质量门不通过时 prompt 指示 agent 阻断并输出具体缺陷

#### 涉及文件
- ~/.studio/skills/goal-start/req/SKILL.md

### impl-skill-enhancement
<!-- MODEL_TIER {"tier":"standard","reason":"单文件但内容最复杂（8 步 TDD + 并行策略 + 反馈回路），需理解 pipeline 调度和 TDD 流程"} -->

#### 验收标准
- [ ] AC2.1: 在 ~/.studio/skills/goal-start/impl/SKILL.md；重写 body 为 8 步 TDD 工作流（PLAN→RED→GREEN→REFACTOR→VERIFY→DOC→COMMIT→CLEANUP）；每步包含执行指令和完成条件；不修改 frontmatter（保留 name:implementation, trigger:goal_start, agentTypes:[executor], tier:fast）
- [ ] AC2.2: 在 impl/SKILL.md body 中定义 PLAN 步骤门控；验证 spec.md 存在且包含 acGroups 数组；spec.md 缺失或格式错误时阻断并输出错误信息；读取 acGroups 依赖关系并按拓扑排序确定执行顺序
- [ ] AC2.3: 在 impl/SKILL.md body 中定义 modelTier 路由逻辑；从 spec.md 的 acGroup.modelTier 字段读取模型档位；standard 用快速模型，premium 用强模型；modelTier 缺失时默认 standard
- [ ] AC2.4: 在 impl/SKILL.md body 中定义 RED 阶段反馈回路；RED 阶段发现 spec 问题（AC 不可测试、接口不存在、依赖缺失）时输出 feedback 文档；feedback 触发 status 回退到 draft 并通知 Analyst 修正
- [ ] AC2.5: 在 impl/SKILL.md body 中定义 AC 标注规范；每条测试用例标注 // AC: AC-xx 注释；GREEN 阶段实现代码必须让所有标注的测试通过；VERIFY 阶段检查 AC 覆盖率（grepACTests）

#### 涉及文件
- ~/.studio/skills/goal-start/impl/SKILL.md

### review-skill-enhancement
<!-- MODEL_TIER {"tier":"standard","reason":"单文件，内容中等复杂度，需理解审查流程和 pipeline 集成点"} -->

#### 验收标准
- [ ] AC3.1: 在 ~/.studio/skills/review/review/SKILL.md；重写 body 为结构化审查流程；输入：git diff 或文件路径；输出：审查报告（overallApproved + acCoverage + issues + suggestions）；不修改 frontmatter（保留 name:code-review, trigger:review, agentTypes:[reviewer], tier:standard）
- [ ] AC3.2: 在 review/SKILL.md body 中定义审查维度；AC 覆盖（每条 AC 对应实现+测试）、代码质量（类型安全/错误处理/可读性）、安全性（无硬编码凭证/无注入/无权限放大）、架构一致性（遵循约定/无重复）；critical 级问题 → overallApproved: false
- [ ] AC3.3: 在 review/SKILL.md body 中定义 recordPattern 集成；审查完成后调用 knowledgeBus.recordPattern() 记录发现的模式（type: 'review_finding'）；模式包含 severity、file、description；不修改 reviewAgent 代码（由 prompt 引导 agent 在审查报告中输出 pattern 建议）
- [ ] AC3.4: 在 review/SKILL.md body 中定义触发意图识别；支持触发词：审查一下/review/看看这段代码/有没有问题/帮我看看；触发词列表写在 SKILL.md body 开头作为元数据提示

#### 涉及文件
- ~/.studio/skills/review/review/SKILL.md
## 约束
- SKILL.md frontmatter 字段（name, trigger, agentTypes, tier, status, version）不可修改——它们决定 skill 的加载时机和权限
- 保留 {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}} 占位符——buildSkillPrompt() 依赖它们做模板替换
- body 中避免使用 --- 分隔符——会破坏 YAML frontmatter 解析器 (loader.ts:L48 的正则)
- SKILL.md body 是 prompt 模板，不是可执行代码——工作流逻辑通过 prompt 指令引导 agent 行为，不通过代码强制
- 现有的 pipeline 基础设施（GoalScheduler, agentRunner, reviewAgent）已支持 req→impl→review 链路——本次只增强 prompt 内容，不修改 pipeline 代码

## AC Groups

```json
[
  {
    "id": "req-skill-enhancement",
    "targetRepo": "studio",
    "acs": [
      "AC1.1: 在 ~/.studio/skills/goal-start/req/SKILL.md；重写 body 为 5 步工作流（CAPTURE→ANALYZE→ARCHITECTURE→DESIGN→SPEC）；每步包含门控检查描述（需求明确/第一性分析/方案已选/设计覆盖/AC质量门）；不修改 frontmatter（保留 name:requirement-analysis, trigger:goal_start, agentTypes:[analyst], tier:premium）",
      "AC1.2: 在 req/SKILL.md body 中定义产出格式；输出 docs/specs/{id}/ 下 4 个文件：requirements.md（需求文档）、architecture.md（架构决策）、design.md（设计文档）、spec.md（验收标准）；spec.md 包含 acGroups JSON 数组结构（id, acs, files, dependencies, modelTier）；不修改 pipeline 代码（产出格式由 agent prompt 引导）",
      "AC1.3: 在 req/SKILL.md body 中定义质量门规则；AC 可测试（有明确断言条件）、无歧义（动词开头）、文件覆盖（每条 AC 有 files）、依赖无环（拓扑排序可解）、全覆盖（需求→AC 1:1映射）、modelTier 合理（fast≤2AC≤3files, premium≥6AC或高风险）；质量门不通过时 prompt 指示 agent 阻断并输出具体缺陷"
    ],
    "files": [
      "~/.studio/skills/goal-start/req/SKILL.md"
    ],
    "dependencies": [],
    "implementationNotes": "1. 读取现有 SKILL.md，保留 frontmatter 不变。2. 重写 body 部分为结构化工作流。3. 每步格式：步骤名 → 门控检查 → 产出 → 通过条件。4. 参考 analyst-prompt.ts L78-L178 的工作流描述（修改点溯源步骤、CONTEXT.md 缓存、AC 结构化要求）。5. 参考 pipeline-utils.ts 的 AcGroup 接口（L19-L29）定义 spec.md 输出格式。6. 保留 {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}} 占位符在 body 末尾。",
    "architectureContext": {
      "functions": [
        "skillLoader.load({ trigger: 'goal_start', agentType: 'analyst' }) @ packages/studio-skill/src/loader.ts:L68",
        "buildAnalystPrompt(requirement, knowledge, accuracyReflection, outputFile, preClassifiedTier?, availableRepos?) @ analyst-prompt.ts:L18",
        "loadSkillTemplate(skillName): SkillTemplate | null @ scheduler-prompt.ts:L38",
        "buildSkillPrompt(skillName, vars): string @ scheduler-prompt.ts:L86"
      ],
      "callChain": "analyst-trigger.service.ts::trigger() → buildAnalystPrompt() → skillLoader.load({trigger:'goal_start', agentType:'analyst'}) → SKILL.md body injected into prompt → Claude Code agent executes workflow steps",
      "imports": [],
      "typesInScope": [
        "AcGroup { id, acs, files, dependencies, implementationNotes?, codePatterns?, gotchas?, modelTier?, modelTierReason? } @ pipeline-utils.ts:L19-L29",
        "RequirementsDocJson { title, summary, tier, acGroups, contractTests, ... } @ analyst-executor.ts"
      ],
      "testMock": [],
      "dangerZones": [
        "frontmatter 的 name/trigger/agentTypes/tier 字段不可修改——它们决定 skill 何时被加载",
        "保留 {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}} 占位符——buildSkillPrompt() 依赖它们",
        "body 中的 YAML frontmatter 分隔符 --- 不可出现在 body 内容中（会破坏解析）"
      ],
      "verifiedAt": "629e36b5"
    },
    "codePatterns": [
      "~/.studio/skills/goal-start/contract-test-writing/SKILL.md — 同级 skill，参考 frontmatter 格式和 body 结构",
      "analyst-prompt.ts:L78-L178 — 修改点溯源步骤、CONTEXT.md 缓存策略、AC 结构化要求",
      "pipeline-utils.ts:L19-L29 — AcGroup 接口定义，spec.md 输出格式参考"
    ],
    "gotchas": [
      "⚠️ 不可删除: {{task}} 等占位符 (消费者: buildSkillPrompt() @ scheduler-prompt.ts:L86)",
      "⚠️ 不可修改: frontmatter 字段 (消费者: skillLoader.load() 过滤逻辑)",
      "⚠️ body 中避免使用 --- 分隔符 (会破坏 YAML frontmatter 解析器 @ loader.ts:L48)"
    ],
    "modelTier": "standard",
    "modelTierReason": "单文件但内容复杂（100+ 行工作流定义），需要理解 pipeline 架构和 analyst prompt 结构"
  },
  {
    "id": "impl-skill-enhancement",
    "targetRepo": "studio",
    "acs": [
      "AC2.1: 在 ~/.studio/skills/goal-start/impl/SKILL.md；重写 body 为 8 步 TDD 工作流（PLAN→RED→GREEN→REFACTOR→VERIFY→DOC→COMMIT→CLEANUP）；每步包含执行指令和完成条件；不修改 frontmatter（保留 name:implementation, trigger:goal_start, agentTypes:[executor], tier:fast）",
      "AC2.2: 在 impl/SKILL.md body 中定义 PLAN 步骤门控；验证 spec.md 存在且包含 acGroups 数组；spec.md 缺失或格式错误时阻断并输出错误信息；读取 acGroups 依赖关系并按拓扑排序确定执行顺序",
      "AC2.3: 在 impl/SKILL.md body 中定义 modelTier 路由逻辑；从 spec.md 的 acGroup.modelTier 字段读取模型档位；standard 用快速模型，premium 用强模型；modelTier 缺失时默认 standard",
      "AC2.4: 在 impl/SKILL.md body 中定义 RED 阶段反馈回路；RED 阶段发现 spec 问题（AC 不可测试、接口不存在、依赖缺失）时输出 feedback 文档；feedback 触发 status 回退到 draft 并通知 Analyst 修正",
      "AC2.5: 在 impl/SKILL.md body 中定义 AC 标注规范；每条测试用例标注 // AC: AC-xx 注释；GREEN 阶段实现代码必须让所有标注的测试通过；VERIFY 阶段检查 AC 覆盖率（grepACTests）"
    ],
    "files": [
      "~/.studio/skills/goal-start/impl/SKILL.md"
    ],
    "dependencies": [],
    "implementationNotes": "1. 读取现有 SKILL.md，保留 frontmatter 不变。2. 重写 body 为 8 步 TDD 工作流。3. 参考 green-only-tdd skill (goal-start/green-only-tdd/SKILL.md) 的 TDD 流程。4. 参考 scheduler-queue.ts 的 modelTier 路由逻辑（L106-110: acGroup.modelTier 优先）。5. 参考 pipeline-utils.ts 的 resolveDependencies() (L68-124) 拓扑排序逻辑。6. 保留 {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}} 占位符。",
    "architectureContext": {
      "functions": [
        "skillLoader.load({ trigger: 'goal_start', agentType: 'executor' }) @ packages/studio-skill/src/loader.ts:L68",
        "buildSubAgentPrompt(input, siblingContext?, companyKnowledge?) @ scheduler-prompt.ts:L116",
        "resolveDependencies(acGroups: AcGroup[]): AcGroup[][] @ pipeline-utils.ts:L68",
        "routeModel(acGroup: AcGroup): { tier, reason } @ pipeline-utils.ts:L134",
        "grepACTests(acs: string[], dir: string): ACTestCoverage[] @ pipeline-utils.ts:L215"
      ],
      "callChain": "GoalScheduler.processGoal() → dispatchStep() → buildSubAgentPrompt() → buildSkillPrompt('sub-agent-workflow', vars) → agentRunner.execute()",
      "imports": [],
      "typesInScope": [
        "AcGroup { id, acs, files, dependencies, modelTier? } @ pipeline-utils.ts:L19-L29",
        "ACTestCoverage { acId, testFile, matched } @ pipeline-utils.ts:L205-L209",
        "HarnessCheckResult { passed, errors } @ pipeline-utils.ts:L263-L266"
      ],
      "testMock": [],
      "dangerZones": [
        "frontmatter 的 name/trigger/agentTypes/tier 字段不可修改",
        "保留 {{task}} 等占位符——buildSkillPrompt() 和 buildSubAgentPrompt() 依赖它们",
        "tier: fast 意味着 SkillLoaderService 的 tier rank 过滤会限制工具权限（fast 只有 Read/Glob/Grep/Bash）"
      ],
      "verifiedAt": "629e36b5"
    },
    "codePatterns": [
      "~/.studio/skills/goal-start/green-only-tdd/SKILL.md — TDD 流程参考",
      "pipeline-utils.ts:L68-L124 — resolveDependencies 拓扑排序",
      "pipeline-utils.ts:L134-L164 — routeModel tier 路由",
      "scheduler-queue.ts:L106-L110 — acGroup.modelTier 优先级逻辑"
    ],
    "gotchas": [
      "⚠️ 不可删除: {{task}} 等占位符 (消费者: buildSkillPrompt())",
      "⚠️ 不可修改: frontmatter tier:fast (影响 SkillLoaderService tier rank 过滤)",
      "⚠️ impl skill 的 tier:fast 意味着 executor 只有 Read/Glob/Grep/Bash 工具——TDD RED 阶段需要 Write/Edit 但 fast tier 不允许 (已有 green-only-tdd skill 也是 fast tier，说明 executor 实际工具权限由 agentRunner 控制，不受 skill tier 限制)"
    ],
    "modelTier": "standard",
    "modelTierReason": "单文件但内容最复杂（8 步 TDD + 并行策略 + 反馈回路），需理解 pipeline 调度和 TDD 流程"
  },
  {
    "id": "review-skill-enhancement",
    "targetRepo": "studio",
    "acs": [
      "AC3.1: 在 ~/.studio/skills/review/review/SKILL.md；重写 body 为结构化审查流程；输入：git diff 或文件路径；输出：审查报告（overallApproved + acCoverage + issues + suggestions）；不修改 frontmatter（保留 name:code-review, trigger:review, agentTypes:[reviewer], tier:standard）",
      "AC3.2: 在 review/SKILL.md body 中定义审查维度；AC 覆盖（每条 AC 对应实现+测试）、代码质量（类型安全/错误处理/可读性）、安全性（无硬编码凭证/无注入/无权限放大）、架构一致性（遵循约定/无重复）；critical 级问题 → overallApproved: false",
      "AC3.3: 在 review/SKILL.md body 中定义 recordPattern 集成；审查完成后调用 knowledgeBus.recordPattern() 记录发现的模式（type: 'review_finding'）；模式包含 severity、file、description；不修改 reviewAgent 代码（由 prompt 引导 agent 在审查报告中输出 pattern 建议）",
      "AC3.4: 在 review/SKILL.md body 中定义触发意图识别；支持触发词：审查一下/review/看看这段代码/有没有问题/帮我看看；触发词列表写在 SKILL.md body 开头作为元数据提示"
    ],
    "files": [
      "~/.studio/skills/review/review/SKILL.md"
    ],
    "dependencies": [],
    "implementationNotes": "1. 读取现有 SKILL.md，保留 frontmatter 不变。2. 重写 body 为结构化审查流程。3. 参考 multi-stance-review 和 forensic-review skill 的审查维度。4. 参考 goal-review.ts L52 的 reviewAgent.reviewParallel() 调用模式。5. 输出格式对齐 goal-review.ts 的审查结论结构。6. 保留 {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}} 占位符。",
    "architectureContext": {
      "functions": [
        "SkillLoader.load({ trigger: 'review', agentType: 'reviewer' }) @ packages/studio-skill/src/loader.ts:L68",
        "handleGoalSucceeded(goalId): Promise<void> @ goal-review.ts:L52",
        "reviewAgent.reviewParallel() — 在 handleGoalSucceeded 中调用"
      ],
      "callChain": "checkGoalCompletion() → handleGoalSucceeded() → reviewAgent.reviewParallel() → skill loaded via SkillLoader({trigger:'review', agentType:'reviewer'})",
      "imports": [],
      "typesInScope": [
        "ReviewResult { overallApproved, acCoverage, issues, suggestions } — 在 review SKILL.md 中定义输出格式"
      ],
      "testMock": [],
      "dangerZones": [
        "frontmatter 的 name/trigger/agentTypes/tier 字段不可修改",
        "保留 {{task}} 等占位符",
        "review skill 在 integration 步骤完成后加载——审查对象是合并后的代码"
      ],
      "verifiedAt": "629e36b5"
    },
    "codePatterns": [
      "~/.studio/skills/review/multi-stance-review/SKILL.md — 多立场审查维度参考",
      "~/.studio/skills/review/forensic-review/SKILL.md — 法证审查模式参考",
      "goal-review.ts:L52 — handleGoalSucceeded 审查流程"
    ],
    "gotchas": [
      "⚠️ 不可删除: {{task}} 等占位符 (消费者: buildSkillPrompt())",
      "⚠️ 不可修改: frontmatter trigger:review (决定 skill 何时被加载)",
      "⚠️ review skill 在 integration 步骤后加载——审查的是合并后的工作树代码，不是单个 acGroup 的改动"
    ],
    "modelTier": "standard",
    "modelTierReason": "单文件，内容中等复杂度，需理解审查流程和 pipeline 集成点"
  }
]
```
## Files

- ~/.studio/skills/goal-start/impl/SKILL.md
- ~/.studio/skills/goal-start/req/SKILL.md
- ~/.studio/skills/review/review/SKILL.md