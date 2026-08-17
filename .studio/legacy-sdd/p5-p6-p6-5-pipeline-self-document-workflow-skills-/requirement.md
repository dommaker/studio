---
id: "sdd-1781453340305-2o5ikj"
slug: "p5-p6-p6-5-pipeline-self-document-workflow-skills-"
title: "P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一"
status: "stale"
version: 2
requirementVersion: 2
parentId: "cmq8agb8e0041wc0zdsi43vzh"
changeType: "L4"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["P5", "P6", "P6.5", "skill-unification", "self-document", "workflow-skills", "pipeline-bootstrap", "AS-021"]
createdAt: "2026-06-10T16:33:57.468Z"
updatedAt: "2026-06-14T16:09:00.304Z"
---

> **DEPRECATED**: Superseded by `p5-p6-p6-5-pipeline-self-document-workflow-skills--ize0`. This doc is kept for historical reference only.

# P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一

三模块管线自举：P5 代码结构提取+LLM 文档生成，P6 三个 workflow skill 定义，P6.5 统一 loadSkill/buildSkillPrompt 接口 + 硬编码迁移

<!-- TASK_TIER {"tier":"premium","reason":"跨 2 仓库 7+ 文件，新建模块(harness code-analysis + studio improver-scheduler)，涉及 LLM 集成 + AST 解析 + 三套 skill 存储统一"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["FileKnowledgeStore @ harness/src/knowledge/store.ts — save/get/list 接口已验证","modelGateway.prompt() @ packages/studio-shared/src/llm/model-gateway.ts — LLM 调用接口已验证","knowledgeBus @ apps/api/src/modules/knowledge/knowledge-bus.service.ts:610 — 单例已验证","sharedStore @ knowledge-bus.service.ts:49 — FileKnowledgeStore 单例已验证","SkillDefinition @ packages/studio-skill/src/types.ts — 类型定义已验证","SkillLoader @ packages/studio-skill/src/loader.ts — 磁盘+DB+缓存加载已验证","skillLoaderService @ apps/api/src/modules/skills/skill-loader.ts — API 层 session 管理已验证","roleConfigService.getOrCreate() @ apps/api/src/modules/roles/role-config.service.ts:269 — 角色配置已验证","RoleConfigData.boundSkills @ role-config.service.ts:39 — string[] 已验证","evolution-scheduler.ts @ apps/api/src/modules/knowledge/evolution-scheduler.ts — 调度器模式已验证"],"unverified":["harness/src/knowledge/primitives/ 目录 — 不存在，需新建","apps/api/src/modules/knowledge/improver-scheduler.service.ts — 不存在，需新建"],"newRequired":["harness/src/knowledge/code-analysis.ts — 新模块：extractCodeStructure()","harness/src/knowledge/primitives/ — 新目录（按用户 spec 要求）","apps/api/src/modules/knowledge/improver-scheduler.service.ts — 新模块：SelfDocumentService","~/.studio/skills/<trigger>/<skillName>/SKILL.md — AS-021 目录结构","packages/studio-skill/src/loader.ts — 新增 loadSkill() + buildSkillPrompt() 导出"]} -->

### Verified
- ✅ FileKnowledgeStore @ harness/src/knowledge/store.ts — save/get/list 接口已验证
- ✅ modelGateway.prompt() @ packages/studio-shared/src/llm/model-gateway.ts — LLM 调用接口已验证
- ✅ knowledgeBus @ apps/api/src/modules/knowledge/knowledge-bus.service.ts:610 — 单例已验证
- ✅ sharedStore @ knowledge-bus.service.ts:49 — FileKnowledgeStore 单例已验证
- ✅ SkillDefinition @ packages/studio-skill/src/types.ts — 类型定义已验证
- ✅ SkillLoader @ packages/studio-skill/src/loader.ts — 磁盘+DB+缓存加载已验证
- ✅ skillLoaderService @ apps/api/src/modules/skills/skill-loader.ts — API 层 session 管理已验证
- ✅ roleConfigService.getOrCreate() @ apps/api/src/modules/roles/role-config.service.ts:269 — 角色配置已验证
- ✅ RoleConfigData.boundSkills @ role-config.service.ts:39 — string[] 已验证
- ✅ evolution-scheduler.ts @ apps/api/src/modules/knowledge/evolution-scheduler.ts — 调度器模式已验证

### ⚠️ Unverified
- ❌ harness/src/knowledge/primitives/ 目录 — 不存在，需新建
- ❌ apps/api/src/modules/knowledge/improver-scheduler.service.ts — 不存在，需新建

### 🆕 New Required
- 📝 harness/src/knowledge/code-analysis.ts — 新模块：extractCodeStructure()
- 📝 harness/src/knowledge/primitives/ — 新目录（按用户 spec 要求）
- 📝 apps/api/src/modules/knowledge/improver-scheduler.service.ts — 新模块：SelfDocumentService
- 📝 ~/.studio/skills/<trigger>/<skillName>/SKILL.md — AS-021 目录结构
- 📝 packages/studio-skill/src/loader.ts — 新增 loadSkill() + buildSkillPrompt() 导出

## AC Groups

### p5-harness
<!-- MODEL_TIER {"tier":"standard","reason":"新建模块但逻辑简单（正则解析），2 文件，无跨模块依赖"} -->

#### 验收标准
- [ ] 在 harness/src/knowledge/code-analysis.ts；新建 CodeStructure 接口（functions/classes/interfaces/types/exports 数组）和 extractCodeStructure(dir: string): CodeStructure 函数；使用正则解析 .ts 文件的 export function/class/interface/type 声明，提取名称、参数、返回类型、JSDoc；目录不存在或无 .ts 文件时返回空结构
- [ ] 在 harness/src/knowledge/index.ts；添加 export { extractCodeStructure } from './code-analysis' 和 export type { CodeStructure } from './code-analysis'；不修改现有导出

#### 涉及文件
- harness/src/knowledge/code-analysis.ts
- harness/src/knowledge/index.ts

### p5-studio
<!-- MODEL_TIER {"tier":"premium","reason":"新建模块 + LLM 集成 + 知识存储写入 + 定时调度，需要理解多个服务的交互"} -->

#### 验收标准
- [ ] 在 apps/api/src/modules/knowledge/improver-scheduler.service.ts；新建 SelfDocumentService 类，实现 runSelfDoc(dirs: string[]) 方法；遍历 dirs 调用 extractCodeStructure()，对每个目录用 modelGateway.prompt() 生成文档 Markdown，用 knowledgeBus 写入 sharedStore（type: 'architecture', layer: 'system', maturity: 'draft'）；LLM 不可用时静默跳过并 logger.warn
- [ ] 在 apps/api/src/modules/knowledge/improver-scheduler.service.ts；新建 startImproverScheduler() 函数（参考 evolution-scheduler.ts 模式），注册 setInterval 定时触发 runSelfDoc()；导出 startImproverScheduler/stopImproverScheduler 单例

#### 涉及文件
- apps/api/src/modules/knowledge/improver-scheduler.service.ts

#### 依赖: p5-harness

### p6-workflow-skills
<!-- MODEL_TIER {"tier":"fast","reason":"纯文件创建，无代码逻辑，3 个独立 .md 文件"} -->

#### 验收标准
- [ ] 在 ~/.studio/skills/goal-start/req/SKILL.md；创建 requirements-analysis skill（frontmatter: name=req, version=1, description=需求分析，trigger=goal_start, agentTypes=[analyst]）；内容：从 Channel 对话提取结构化 RequirementsDoc 的步骤（读对话→识别立场→提取 AC→分组→输出 JSON）
- [ ] 在 ~/.studio/skills/goal-start/impl/SKILL.md；创建 implementation skill（frontmatter: name=impl, version=1, description=TDD 实现，trigger=goal_start, agentTypes=[executor]）；内容：TDD 实现流程（读 AC→写测试→运行→最小实现→重构→验证）
- [ ] 在 ~/.studio/skills/review/code-review/SKILL.md；创建 code-review skill（frontmatter: name=code-review, version=1, description=多立场代码审查，trigger=review, agentTypes=[reviewer]）；内容：多立场审查流程（skeptic→architect→executor→pragmatist，逐 AC 验证，写 .review-report.json）

#### 涉及文件
- ~/.studio/skills/goal-start/req/SKILL.md
- ~/.studio/skills/goal-start/impl/SKILL.md
- ~/.studio/skills/review/code-review/SKILL.md

### p65-unified-loader
<!-- MODEL_TIER {"tier":"standard","reason":"修改 4 文件，跨 package 边界（studio-skill → api/goals），需要理解三个不同的 skill 加载机制"} -->

#### 验收标准
- [ ] 在 packages/studio-skill/src/loader.ts；新增 loadSkill(skillName: string): SkillDefinition | null 公开方法；按优先级查找：1) SKILLS_DIR/<trigger>/<skillName>/SKILL.md（AS-021 目录结构），2) SKILLS_DIR/<skillName>.md（扁平文件兼容），3) cache 中查找；找到后解析 frontmatter 返回 SkillDefinition
- [ ] 在 packages/studio-skill/src/loader.ts；新增 buildSkillPrompt(skillName: string, vars: Record<string, string>): string 公开方法；调用 loadSkill 获取 prompt body，替换 {{task}}/{{constraints}}/{{knowledgeContext}}/{{capabilities}} 占位符；skill 不存在时返回空字符串
- [ ] 在 packages/studio-skill/src/loader.ts；修改 refreshCache() 支持 AS-021 目录结构：扫描 SKILLS_DIR 下的 trigger 子目录（goal-start/review/integration/always），读取每个 <trigger>/<skillName>/SKILL.md；保持对扁平 .md 文件的向后兼容；统一 SKILLS_DIR 默认路径为 ~/.studio/skills/
- [ ] 在 apps/api/src/modules/goals/scheduler-prompt.ts；移除本地 loadSkillTemplate() 和 buildSkillPrompt() 实现，改为从 @dommaker/studio-skill 导入 skillLoader 的 loadSkill/buildSkillPrompt；更新 buildSubAgentPrompt() 调用链使用新的统一接口

#### 涉及文件
- packages/studio-skill/src/loader.ts
- packages/studio-skill/src/index.ts
- apps/api/src/modules/goals/scheduler-prompt.ts
- apps/api/src/modules/goals/pipeline-utils.ts

### p65-workflow-integration
<!-- MODEL_TIER {"tier":"standard","reason":"修改 2 个代码文件 + 创建 10 个 .md 文件，Role→Skill 绑定逻辑变更是关键路径"} -->

#### 验收标准
- [ ] 在 ~/.studio/skills/goal-start/req/SKILL.md、~/.studio/skills/goal-start/impl/SKILL.md、~/.studio/skills/review/code-review/SKILL.md（来自 p6-workflow-skills）；创建 3 个 SKILL.md 文件（如果 p6-workflow-skills 未创建）；在 packages/studio-skill/src/loader.ts 的 refreshCache() 中验证这 3 个 skill 能被正确加载
- [ ] 在 apps/api/src/modules/goals/scheduler-dispatch.ts L90-L127；将 boundSkills 加载逻辑从 skillLoaderService.loadSkill() 改为使用 package-level skillLoader.loadSkill()（从 @dommaker/studio-skill 导入）；移除对 API-level skillLoaderService 的动态 import；保留 RoleConfigData.boundSkills 读取逻辑不变
- [ ] 在 packages/studio-skill/src/definitions/index.ts；将 10 个硬编码 SkillDefinition 迁移为 AS-021 SKILL.md 文件：green-only-tdd → ~/.studio/skills/goal-start/green-only-tdd/SKILL.md，contract-test-writing → ~/.studio/skills/goal-start/contract-test-writing/SKILL.md，stuck-recovery → ~/.studio/skills/goal-start/stuck-recovery/SKILL.md，behaviour-constraints → ~/.studio/skills/always/behaviour-constraints/SKILL.md，multi-stance-review → ~/.studio/skills/review/multi-stance-review/SKILL.md，knowledge-extraction → ~/.studio/skills/always/knowledge-extraction/SKILL.md，forensic-review → ~/.studio/skills/review/forensic-review/SKILL.md，tool-risk → ~/.studio/skills/always/tool-risk/SKILL.md，integration-merge → ~/.studio/skills/integration/integration-merge/SKILL.md，sub-agent-workflow → ~/.studio/skills/goal-start/sub-agent-workflow/SKILL.md

#### 涉及文件
- apps/api/src/modules/goals/scheduler-dispatch.ts
- packages/studio-skill/src/definitions/index.ts
- ~/.studio/skills/goal-start/green-only-tdd/SKILL.md
- ~/.studio/skills/goal-start/contract-test-writing/SKILL.md
- ~/.studio/skills/goal-start/stuck-recovery/SKILL.md
- ~/.studio/skills/goal-start/sub-agent-workflow/SKILL.md
- ~/.studio/skills/always/behaviour-constraints/SKILL.md
- ~/.studio/skills/always/knowledge-extraction/SKILL.md
- ~/.studio/skills/always/tool-risk/SKILL.md
- ~/.studio/skills/review/multi-stance-review/SKILL.md
- ~/.studio/skills/review/forensic-review/SKILL.md
- ~/.studio/skills/integration/integration-merge/SKILL.md

#### 依赖: p65-unified-loader

### p65-migration
<!-- MODEL_TIER {"tier":"fast","reason":"主要是删除代码 + 更新测试，3 文件，逻辑简单（前提是前置组已完成）"} -->

#### 验收标准
- [ ] 在 packages/studio-skill/src/definitions/index.ts；删除 allSkillDefinitions 数组和所有 10 个硬编码 SkillDefinition 导出（greenOnlyTdd, contractTestWriting, stuckRecovery, behaviourConstraints, multiStanceReview, knowledgeExtraction, forensicReview, toolRisk, integrationMerge, subAgentWorkflow）；保留文件作为占位（空 export {}）或完全删除
- [ ] 在 packages/studio-skill/src/loader.ts；修改构造函数：customSkills 为空时不再 fallback 到 allSkillDefinitions，而是设置为空数组；refreshCache() 仅从磁盘和 DB 加载；验证 10 个迁移后的 .md skill + 3 个新 workflow skill 全部可被 loadAllFromDisk() 发现
- [ ] 在 packages/studio-skill/src/__tests__/loader.test.ts；更新测试：移除对 allSkillDefinitions 的依赖，改为 mock fs 返回 SKILL.md 文件；验证 loadSkill()、buildSkillPrompt()、loadAllFromDisk() 新方法；验证 13 个 skill（10 迁移 + 3 新）全部可加载

#### 涉及文件
- packages/studio-skill/src/definitions/index.ts
- packages/studio-skill/src/loader.ts
- packages/studio-skill/src/__tests__/loader.test.ts

#### 依赖: p65-unified-loader, p65-workflow-integration
## 约束
- harness 包不添加 typescript 作为 runtime dependency（保持轻量，用正则解析）
- SKILLS_DIR 统一为 ~/.studio/skills/（AS-021 标准路径）
- SKILL.md frontmatter 必须有 name + version + description（AS-021 最小要求）
- 向后兼容：loader 支持扁平 .md 文件和 AS-021 目录结构两种格式
- scheduler-dispatch.ts 的 Role→Skill 绑定逻辑只改数据来源（skillLoaderService → skillLoader），不改注入逻辑
- evolution-scheduler.ts 不修改（P5 improver-scheduler 是独立调度器）
- stuck-recovery 的动态 prompt 用 {{stuckCount}} 占位符，调用方负责替换
<!-- GATE_REVISION_ATTEMPT 1 -->

## AC Groups

```json
[
  {
    "id": "p5-harness",
    "targetRepo": "harness",
    "acs": [
      "在 harness/src/knowledge/code-analysis.ts；新建 CodeStructure 接口（functions/classes/interfaces/types/exports 数组）和 extractCodeStructure(dir: string): CodeStructure 函数；使用正则解析 .ts 文件的 export function/class/interface/type 声明，提取名称、参数、返回类型、JSDoc；目录不存在或无 .ts 文件时返回空结构",
      "在 harness/src/knowledge/index.ts；添加 export { extractCodeStructure } from './code-analysis' 和 export type { CodeStructure } from './code-analysis'；不修改现有导出"
    ],
    "files": [
      "harness/src/knowledge/code-analysis.ts",
      "harness/src/knowledge/index.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. 新建 code-analysis.ts：定义 CodeStructure 接口（{functions: {name, params, returnType, jsdoc}[], classes: {name, methods, jsdoc}[], interfaces: {name, properties, jsdoc}[], types: {name, definition, jsdoc}[], exports: string[]}）。2. 实现 extractCodeStructure(dir)：用 fs.readdirSync 读 .ts/.tsx 文件，用正则匹配 export 声明。3. 不使用 TypeScript compiler API（harness 无 ts 依赖，保持轻量）。4. 在 index.ts 添加 re-export。",
    "architectureContext": {
      "functions": [
        "extractCodeStructure(dir: string): CodeStructure — 新函数 @ code-analysis.ts",
        "FileKnowledgeStore.save(entry: KnowledgeEntry): void @ store.ts:L48 — 不在本组修改，但 P5 studio 会调用"
      ],
      "callChain": "P5 studio SelfDocumentService.runSelfDoc() → extractCodeStructure(dir) → 返回 CodeStructure JSON",
      "imports": [
        "import * as fs from 'fs'",
        "import * as path from 'path'"
      ],
      "typesInScope": [
        "CodeStructure { functions: CodeFunction[]; classes: CodeClass[]; interfaces: CodeInterface[]; types: CodeType[]; exports: string[] } — 新定义 @ code-analysis.ts",
        "CodeFunction { name: string; params: string; returnType: string; jsdoc: string } — 新定义 @ code-analysis.ts"
      ],
      "testMock": [
        "jest.mock('fs') — mock readdirSync, readFileSync",
        "const mockFiles = { 'test.ts': 'export function foo(x: number): string { return String(x); }' }"
      ],
      "dangerZones": [
        "index.ts 当前 22 行导出 — 不修改已有导出，只追加",
        "harness 用 Jest（非 Vitest），测试文件用 jest.mock"
      ],
      "verifiedAt": "2fe026c"
    },
    "codePatterns": [
      "参考 harness/src/knowledge/store.ts — fs + path + js-yaml 导入模式",
      "参考 harness/src/knowledge/query.ts — 正则解析模式"
    ],
    "gotchas": [
      "⚠️ harness 用 CommonJS (tsconfig module: CommonJS)，import/export 编译为 require/module.exports",
      "⚠️ harness 用 Jest（非 Vitest），测试用 jest.mock / jest.fn",
      "⚠️ 不添加 typescript 作为 dependency（harness 保持轻量），用正则解析"
    ],
    "modelTier": "standard",
    "modelTierReason": "新建模块但逻辑简单（正则解析），2 文件，无跨模块依赖"
  },
  {
    "id": "p5-studio",
    "targetRepo": "studio",
    "acs": [
      "在 apps/api/src/modules/knowledge/improver-scheduler.service.ts；新建 SelfDocumentService 类，实现 runSelfDoc(dirs: string[]) 方法；遍历 dirs 调用 extractCodeStructure()，对每个目录用 modelGateway.prompt() 生成文档 Markdown，用 knowledgeBus 写入 sharedStore（type: 'architecture', layer: 'system', maturity: 'draft'）；LLM 不可用时静默跳过并 logger.warn",
      "在 apps/api/src/modules/knowledge/improver-scheduler.service.ts；新建 startImproverScheduler() 函数（参考 evolution-scheduler.ts 模式），注册 setInterval 定时触发 runSelfDoc()；导出 startImproverScheduler/stopImproverScheduler 单例"
    ],
    "files": [
      "apps/api/src/modules/knowledge/improver-scheduler.service.ts"
    ],
    "dependencies": [
      "p5-harness"
    ],
    "implementationNotes": "1. 新建 improver-scheduler.service.ts。2. SelfDocumentService 类：runSelfDoc(dirs) 遍历 dirs，对每个调 extractCodeStructure，格式化为 Markdown prompt，调 modelGateway.prompt() 生成文档，用 knowledgeBus.write() 或 sharedStore.save() 写入。3. startImproverScheduler()：setInterval 1 小时，调 runSelfDoc。4. 参考 evolution-scheduler.ts 的定时器模式。5. 参考 evolution.service.ts 的 modelGateway.promptJson() 调用模式。",
    "architectureContext": {
      "functions": [
        "SelfDocumentService.runSelfDoc(dirs: string[]): Promise<void> — 新函数 @ improver-scheduler.service.ts",
        "startImproverScheduler(): void — 新函数 @ improver-scheduler.service.ts",
        "stopImproverScheduler(): void — 新函数 @ improver-scheduler.service.ts",
        "extractCodeStructure(dir: string): CodeStructure — 来自 @dommaker/harness（P5 harness 产出）",
        "modelGateway.prompt(text: string, systemPrompt?: string): Promise<string> @ packages/studio-shared/src/llm/model-gateway.ts",
        "knowledgeBus.write(entry: BusEntry): Promise<void> @ knowledge-bus.service.ts:121"
      ],
      "callChain": "startImproverScheduler() → setInterval(1h) → runSelfDoc(dirs) → extractCodeStructure(dir) → modelGateway.prompt() → sharedStore.save()",
      "imports": [
        "import { extractCodeStructure } from '@dommaker/harness'",
        "import { modelGateway, logger } from '@dommaker/studio-shared'",
        "import { knowledgeBus, sharedStore } from './knowledge-bus.service'",
        "import type { KnowledgeEntry } from '@dommaker/harness'"
      ],
      "typesInScope": [
        "CodeStructure { functions: CodeFunction[]; classes: CodeClass[]; interfaces: CodeInterface[]; types: CodeType[]; exports: string[] } — 来自 @dommaker/harness",
        "KnowledgeEntry { id, type, title, content, maturity, layer, ... } @ harness/src/knowledge/types.ts:26",
        "BusEntry { type, content, source, ... } @ knowledge-bus.service.ts"
      ],
      "testMock": [
        "vi.mock('@dommaker/harness', () => ({ extractCodeStructure: vi.fn().mockReturnValue({ functions: [], classes: [], interfaces: [], types: [], exports: [] }) }))",
        "vi.mock('@dommaker/studio-shared', () => ({ modelGateway: { prompt: vi.fn().mockResolvedValue('# Generated Doc') }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))",
        "vi.mock('./knowledge-bus.service', () => ({ knowledgeBus: { write: vi.fn().mockResolvedValue(undefined) }, sharedStore: { save: vi.fn() } }))"
      ],
      "dangerZones": [
        "knowledgeBus.write() 是 async — 必须 await",
        "modelGateway.prompt() 可能抛异常 — 用 try/catch 包裹，logger.warn 后继续下一个目录",
        "sharedStore.save() 是同步的 — 如果用 sharedStore 需要确保 entry 结构完整"
      ],
      "verifiedAt": "2fe026c"
    },
    "codePatterns": [
      "参考 evolution-scheduler.ts — startEvolutionScheduler()/stopEvolutionScheduler() 定时器模式",
      "参考 evolution.service.ts:51 — modelGateway.promptJson() 调用模式",
      "参考 evolution.service.ts:14 — import { logger, modelGateway } from '@dommaker/studio-shared'"
    ],
    "gotchas": [
      "⚠️ extractCodeStructure 来自 @dommaker/harness — 需要 P5 harness 先完成并发布",
      "⚠️ knowledgeBus.write() 需要有效的 BusEntry.type — 'architecture' 映射到 KnowledgeType 'architecture'",
      "⚠️ sharedStore 路径是 ~/.studio/knowledge/ — 文档写入此目录"
    ],
    "modelTier": "premium",
    "modelTierReason": "新建模块 + LLM 集成 + 知识存储写入 + 定时调度，需要理解多个服务的交互"
  },
  {
    "id": "p6-workflow-skills",
    "targetRepo": "studio",
    "acs": [
      "在 ~/.studio/skills/goal-start/req/SKILL.md；创建 requirements-analysis skill（frontmatter: name=req, version=1, description=需求分析，trigger=goal_start, agentTypes=[analyst]）；内容：从 Channel 对话提取结构化 RequirementsDoc 的步骤（读对话→识别立场→提取 AC→分组→输出 JSON）",
      "在 ~/.studio/skills/goal-start/impl/SKILL.md；创建 implementation skill（frontmatter: name=impl, version=1, description=TDD 实现，trigger=goal_start, agentTypes=[executor]）；内容：TDD 实现流程（读 AC→写测试→运行→最小实现→重构→验证）",
      "在 ~/.studio/skills/review/code-review/SKILL.md；创建 code-review skill（frontmatter: name=code-review, version=1, description=多立场代码审查，trigger=review, agentTypes=[reviewer]）；内容：多立场审查流程（skeptic→architect→executor→pragmatist，逐 AC 验证，写 .review-report.json）"
    ],
    "files": [
      "~/.studio/skills/goal-start/req/SKILL.md",
      "~/.studio/skills/goal-start/impl/SKILL.md",
      "~/.studio/skills/review/code-review/SKILL.md"
    ],
    "dependencies": [],
    "implementationNotes": "1. 创建 AS-021 目录结构：~/.studio/skills/goal-start/req/、~/.studio/skills/goal-start/impl/、~/.studio/skills/review/code-review/。2. 每个目录下创建 SKILL.md，包含 YAML frontmatter + Markdown body。3. 参考 AS-021 spec 的 SKILL.md 格式。4. 参考现有硬编码 skill 的 prompt 内容（definitions/index.ts）。",
    "architectureContext": {
      "functions": [],
      "callChain": "SkillLoader.loadAllFromDisk() → 读 SKILLS_DIR/<trigger>/<name>/SKILL.md → parseFrontmatter → frontmatterToSkillDefinition",
      "imports": [],
      "typesInScope": [
        "SkillTrigger @ packages/studio-skill/src/types.ts:8 — 'goal_start' | 'review' | ...",
        "SkillTier @ types.ts:17 — 'fast' | 'standard' | 'premium'",
        "SkillDefinition @ types.ts:19 — { id, name, description, trigger, agentTypes, tier, prompt }"
      ],
      "testMock": [],
      "dangerZones": [
        "SKILL.md frontmatter 必须有 name 字段（否则 loader 跳过）",
        "status 字段默认 'published'（不写则 loader 检查通过）",
        "目录名 = skill id（loader 用目录名作为 skillName）"
      ],
      "verifiedAt": "2fe026c"
    },
    "codePatterns": [
      "参考 ~/.studio/knowledge/skills/*.md — 现有 .md 文件的 frontmatter 格式",
      "参考 AS-021 spec 的 SKILL.md 格式示例"
    ],
    "gotchas": [
      "⚠️ 目录结构必须是 <trigger>/<skillName>/SKILL.md（不是 <skillName>.md）",
      "⚠️ 3 个 skill 的 agentTypes 必须匹配现有角色：analyst/executor/reviewer",
      "⚠️ impl skill 的 prompt 应参考 green-only-tdd 硬编码定义的内容"
    ],
    "modelTier": "fast",
    "modelTierReason": "纯文件创建，无代码逻辑，3 个独立 .md 文件"
  },
  {
    "id": "p65-unified-loader",
    "targetRepo": "studio",
    "acs": [
      "在 packages/studio-skill/src/loader.ts；新增 loadSkill(skillName: string): SkillDefinition | null 公开方法；按优先级查找：1) SKILLS_DIR/<trigger>/<skillName>/SKILL.md（AS-021 目录结构），2) SKILLS_DIR/<skillName>.md（扁平文件兼容），3) cache 中查找；找到后解析 frontmatter 返回 SkillDefinition",
      "在 packages/studio-skill/src/loader.ts；新增 buildSkillPrompt(skillName: string, vars: Record<string, string>): string 公开方法；调用 loadSkill 获取 prompt body，替换 {{task}}/{{constraints}}/{{knowledgeContext}}/{{capabilities}} 占位符；skill 不存在时返回空字符串",
      "在 packages/studio-skill/src/loader.ts；修改 refreshCache() 支持 AS-021 目录结构：扫描 SKILLS_DIR 下的 trigger 子目录（goal-start/review/integration/always），读取每个 <trigger>/<skillName>/SKILL.md；保持对扁平 .md 文件的向后兼容；统一 SKILLS_DIR 默认路径为 ~/.studio/skills/",
      "在 apps/api/src/modules/goals/scheduler-prompt.ts；移除本地 loadSkillTemplate() 和 buildSkillPrompt() 实现，改为从 @dommaker/studio-skill 导入 skillLoader 的 loadSkill/buildSkillPrompt；更新 buildSubAgentPrompt() 调用链使用新的统一接口"
    ],
    "files": [
      "packages/studio-skill/src/loader.ts",
      "packages/studio-skill/src/index.ts",
      "apps/api/src/modules/goals/scheduler-prompt.ts",
      "apps/api/src/modules/goals/pipeline-utils.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. 在 SkillLoader 类上新增 loadSkill(skillName) 和 buildSkillPrompt(skillName, vars) 公开方法。2. refreshCache() 扩展：扫描 SKILLS_DIR 下 trigger 子目录（goal-start/ → goal_start trigger, review/ → review trigger, integration/ → integration trigger, always/ → always trigger）。3. 目录名到 trigger 的映射：goal-start→goal_start, review→review, integration→integration, always→always。4. 保持扁平文件兼容：loadAllFromDisk() 先扫描扁平 .md，再扫描子目录。5. scheduler-prompt.ts：删除 L16-64 的 loadSkillTemplate/buildSkillPrompt，改为 import { skillLoader } from '@dommaker/studio-skill'。6. pipeline-utils.ts：删除本地 buildSkillPrompt（L33-L56），改为 import/re-export。",
    "architectureContext": {
      "functions": [
        "SkillLoader.loadSkill(skillName: string): SkillDefinition | null — 新公开方法 @ loader.ts",
        "SkillLoader.buildSkillPrompt(skillName: string, vars: Record<string, string>): string — 新公开方法 @ loader.ts",
        "SkillLoader.refreshCache(): void — 修改 @ loader.ts:L205",
        "SkillLoader.loadAllFromDisk(): SkillDefinition[] — 修改 @ loader.ts:L177",
        "loadSkillTemplate(skillName: string): SkillTemplate | null — 删除 @ scheduler-prompt.ts:L16",
        "buildSkillPrompt(skillName: string, vars: Record<string, string>): string — 删除 @ scheduler-prompt.ts:L42",
        "buildSubAgentPrompt(input, siblingContext?, companyKnowledge?): string — 修改调用 @ scheduler-prompt.ts:L107"
      ],
      "callChain": "scheduler-dispatch.ts → buildSubAgentPrompt() → skillLoader.buildSkillPrompt('sub-agent-workflow', vars) → skillLoader.loadSkill('sub-agent-workflow')",
      "imports": [
        "import { skillLoader } from '@dommaker/studio-skill' — scheduler-prompt.ts 新增",
        "import { skillLoader } from '@dommaker/studio-skill' — pipeline-utils.ts 新增"
      ],
      "typesInScope": [
        "SkillDefinition @ packages/studio-skill/src/types.ts:19 — { id, name, description, trigger, agentTypes, tier, prompt }",
        "SkillTrigger @ types.ts:8 — 'goal_start' | 'goal_continue' | 'review' | 'knowledge_extract' | 'integration' | 'sub_agent' | 'always'",
        "SkillTier @ types.ts:17 — 'fast' | 'standard' | 'premium'",
        "SkillFrontmatter @ loader.ts:26 — { name, description?, trigger?, agentTypes?, tier?, tools?, status?, version? }"
      ],
      "testMock": [
        "vi.mock('fs') — mock existsSync, readdirSync, readFileSync",
        "vi.mock('os') — mock homedir 返回 '/tmp/test-home'",
        "const loader = new SkillLoader() — 测试新方法"
      ],
      "dangerZones": [
        "loader.ts:L74 prisma: any — 已有 tech debt，不修复（不在本组范围）",
        "loader.ts:L205 refreshCache() 是 private — 新方法可以调用它，但外部不能",
        "scheduler-prompt.ts:L277 getCompanyKnowledge() 仍用 Prisma query — 不修改（不同功能）",
        "pipeline-utils.ts 的 buildSkillPrompt 可能被其他文件 import — 需要 re-export 保持兼容"
      ],
      "verifiedAt": "2fe026c"
    },
    "codePatterns": [
      "参考 loader.ts:L158-L171 — loadFromDisk() 现有的 frontmatter 解析模式",
      "参考 loader.ts:L205-L257 — refreshCache() 现有的合并策略（disk > DB > hardcoded）",
      "参考 scheduler-prompt.ts:L42-L64 — 现有的 buildSkillPrompt 占位符替换模式"
    ],
    "gotchas": [
      "⚠️ SKILLS_DIR 有两个不同默认值：pipeline-utils 用 ~/.studio/skills，scheduler-prompt 用 ~/.studio/knowledge/skills — 统一为 ~/.studio/skills/",
      "⚠️ AS-021 目录名 goal-start（带连字符）映射到 trigger goal_start（下划线）",
      "⚠️ refreshCache 是异步的（Prisma 查询是 promise）— 新的磁盘扫描逻辑插入在 Prisma 查询之前",
      "⚠️ pipeline-utils re-export buildSkillPrompt 时需保持函数签名兼容"
    ],
    "modelTier": "standard",
    "modelTierReason": "修改 4 文件，跨 package 边界（studio-skill → api/goals），需要理解三个不同的 skill 加载机制"
  },
  {
    "id": "p65-workflow-integration",
    "targetRepo": "studio",
    "acs": [
      "在 ~/.studio/skills/goal-start/req/SKILL.md、~/.studio/skills/goal-start/impl/SKILL.md、~/.studio/skills/review/code-review/SKILL.md（来自 p6-workflow-skills）；创建 3 个 SKILL.md 文件（如果 p6-workflow-skills 未创建）；在 packages/studio-skill/src/loader.ts 的 refreshCache() 中验证这 3 个 skill 能被正确加载",
      "在 apps/api/src/modules/goals/scheduler-dispatch.ts L90-L127；将 boundSkills 加载逻辑从 skillLoaderService.loadSkill() 改为使用 package-level skillLoader.loadSkill()（从 @dommaker/studio-skill 导入）；移除对 API-level skillLoaderService 的动态 import；保留 RoleConfigData.boundSkills 读取逻辑不变",
      "在 packages/studio-skill/src/definitions/index.ts；将 10 个硬编码 SkillDefinition 迁移为 AS-021 SKILL.md 文件：green-only-tdd → ~/.studio/skills/goal-start/green-only-tdd/SKILL.md，contract-test-writing → ~/.studio/skills/goal-start/contract-test-writing/SKILL.md，stuck-recovery → ~/.studio/skills/goal-start/stuck-recovery/SKILL.md，behaviour-constraints → ~/.studio/skills/always/behaviour-constraints/SKILL.md，multi-stance-review → ~/.studio/skills/review/multi-stance-review/SKILL.md，knowledge-extraction → ~/.studio/skills/always/knowledge-extraction/SKILL.md，forensic-review → ~/.studio/skills/review/forensic-review/SKILL.md，tool-risk → ~/.studio/skills/always/tool-risk/SKILL.md，integration-merge → ~/.studio/skills/integration/integration-merge/SKILL.md，sub-agent-workflow → ~/.studio/skills/goal-start/sub-agent-workflow/SKILL.md"
    ],
    "files": [
      "apps/api/src/modules/goals/scheduler-dispatch.ts",
      "packages/studio-skill/src/definitions/index.ts",
      "~/.studio/skills/goal-start/green-only-tdd/SKILL.md",
      "~/.studio/skills/goal-start/contract-test-writing/SKILL.md",
      "~/.studio/skills/goal-start/stuck-recovery/SKILL.md",
      "~/.studio/skills/goal-start/sub-agent-workflow/SKILL.md",
      "~/.studio/skills/always/behaviour-constraints/SKILL.md",
      "~/.studio/skills/always/knowledge-extraction/SKILL.md",
      "~/.studio/skills/always/tool-risk/SKILL.md",
      "~/.studio/skills/review/multi-stance-review/SKILL.md",
      "~/.studio/skills/review/forensic-review/SKILL.md",
      "~/.studio/skills/integration/integration-merge/SKILL.md"
    ],
    "dependencies": [
      "p65-unified-loader"
    ],
    "implementationNotes": "1. 从 definitions/index.ts 提取每个 skill 的 prompt 内容，写入对应 SKILL.md。2. SKILL.md 格式：YAML frontmatter (name, version:1, description, trigger, agentTypes, tier) + Markdown body (prompt 内容)。3. scheduler-dispatch.ts L97：`const { skillLoaderService } = await import('../skills/skill-loader.js')` → 改为顶部 `import { skillLoader } from '@dommaker/studio-skill'`。4. L103 `skillLoaderService.loadSkill(...)` → `skillLoader.loadSkill(skillName)`。5. stuck-recovery 的 prompt 是动态的（含 stuckCount 变量）— SKILL.md 中用 {{stuckCount}} 占位符。6. 注意：p6-workflow-skills 创建的 3 个新 skill（req/impl/code-review）也需要在此验证。",
    "architectureContext": {
      "functions": [
        "dispatchStep(execWithStep, goal, ctx: DispatchContext): Promise<void> @ scheduler-dispatch.ts — 修改 L90-L127",
        "SkillLoader.loadSkill(skillName: string): SkillDefinition | null @ loader.ts — 来自 p65-unified-loader",
        "roleConfigService.getOrCreate(roleType: RoleType, companyId: string): Promise<RoleConfigData> @ role-config.service.ts:269"
      ],
      "callChain": "GoalScheduler.tick() → dispatchStep() → roleConfigService.getOrCreate('executor') → boundSkills → skillLoader.loadSkill(skillName) → boundSkillPrompts.push()",
      "imports": [
        "import { skillLoader } from '@dommaker/studio-skill' — scheduler-dispatch.ts 顶部新增",
        "删除：const { skillLoaderService } = await import('../skills/skill-loader.js') — scheduler-dispatch.ts:L97"
      ],
      "typesInScope": [
        "RoleConfigData.boundSkills: string[] @ role-config.service.ts:39",
        "SkillDefinition @ packages/studio-skill/src/types.ts:19",
        "DispatchContext @ scheduler-dispatch.ts"
      ],
      "testMock": [
        "vi.mock('@dommaker/studio-skill', () => ({ skillLoader: { loadSkill: vi.fn().mockReturnValue({ id: 'test', name: 'test', prompt: 'test prompt' }), load: vi.fn().mockReturnValue([]), buildSkillPrompt: vi.fn().mockReturnValue('') } }))",
        "vi.mock('../roles/role-config.service', () => ({ roleConfigService: { getOrCreate: vi.fn().mockResolvedValue({ boundSkills: ['green-only-tdd'], boundConstraints: [] }) } }))"
      ],
      "dangerZones": [
        "scheduler-dispatch.ts:L99 parseJsonField — 不修改此行，保持 boundSkills 解析逻辑",
        "scheduler-dispatch.ts:L197 boundSkillPrompts 注入到 prompt — 不修改注入逻辑，只改数据来源",
        "definitions/index.ts 的 stuckRecovery prompt 是函数(stuckCount) — SKILL.md 中用 {{stuckCount}} 占位符替代"
      ],
      "verifiedAt": "2fe026c"
    },
    "codePatterns": [
      "参考 definitions/index.ts — 现有 10 个 skill 的 prompt 内容",
      "参考 scheduler-dispatch.ts:L90-L127 — 现有的 Role→Skill 绑定加载逻辑",
      "参考 AS-021 spec 的 SKILL.md 格式示例"
    ],
    "gotchas": [
      "⚠️ stuck-recovery 的 prompt 含动态变量 {{stuckCount}} — SKILL.md 中保留占位符，调用方替换",
      "⚠️ contract-test-writing 是 premium tier — 不要降级",
      "⚠️ scheduler-dispatch.ts 的 dynamic import 改为顶部 import 会改变模块加载时机 — 确认无副作用",
      "⚠️ 10 个 SKILL.md 文件创建后，loader 的 refreshCache 需要能发现它们"
    ],
    "modelTier": "standard",
    "modelTierReason": "修改 2 个代码文件 + 创建 10 个 .md 文件，Role→Skill 绑定逻辑变更是关键路径"
  },
  {
    "id": "p65-migration",
    "targetRepo": "studio",
    "acs": [
      "在 packages/studio-skill/src/definitions/index.ts；删除 allSkillDefinitions 数组和所有 10 个硬编码 SkillDefinition 导出（greenOnlyTdd, contractTestWriting, stuckRecovery, behaviourConstraints, multiStanceReview, knowledgeExtraction, forensicReview, toolRisk, integrationMerge, subAgentWorkflow）；保留文件作为占位（空 export {}）或完全删除",
      "在 packages/studio-skill/src/loader.ts；修改构造函数：customSkills 为空时不再 fallback 到 allSkillDefinitions，而是设置为空数组；refreshCache() 仅从磁盘和 DB 加载；验证 10 个迁移后的 .md skill + 3 个新 workflow skill 全部可被 loadAllFromDisk() 发现",
      "在 packages/studio-skill/src/__tests__/loader.test.ts；更新测试：移除对 allSkillDefinitions 的依赖，改为 mock fs 返回 SKILL.md 文件；验证 loadSkill()、buildSkillPrompt()、loadAllFromDisk() 新方法；验证 13 个 skill（10 迁移 + 3 新）全部可加载"
    ],
    "files": [
      "packages/studio-skill/src/definitions/index.ts",
      "packages/studio-skill/src/loader.ts",
      "packages/studio-skill/src/__tests__/loader.test.ts"
    ],
    "dependencies": [
      "p65-unified-loader",
      "p65-workflow-integration"
    ],
    "implementationNotes": "1. definitions/index.ts：删除所有硬编码定义（~280 行），文件保留为空 export {} 或删除。2. loader.ts 构造函数：`const skills = customSkills || allSkillDefinitions` → `const skills = customSkills || []`。3. loader.ts refreshCache：移除 `for (const s of allSkillDefinitions) { if (!merged.has(s.id)) merged.set(s.id, s); }` 这段 hardcoded fallback。4. 测试更新：mock fs 返回 SKILL.md 文件内容，验证 loadSkill('green-only-tdd') 返回正确的 SkillDefinition。5. 验证：运行 npm test 确认所有测试通过。",
    "architectureContext": {
      "functions": [
        "SkillLoader.constructor(customSkills?: SkillDefinition[]) @ loader.ts:L80 — 修改 fallback 逻辑",
        "SkillLoader.refreshCache() @ loader.ts:L205 — 移除 hardcoded fallback",
        "SkillLoader.loadSkill(skillName: string): SkillDefinition | null @ loader.ts — 新方法（来自 p65-unified-loader）",
        "SkillLoader.loadAllFromDisk(): SkillDefinition[] @ loader.ts:L177 — 已修改（来自 p65-unified-loader）"
      ],
      "callChain": "new SkillLoader() → constructor(customSkills || []) → refreshCache() → loadAllFromDisk() → SKILL.md files only",
      "imports": [
        "删除：import { allSkillDefinitions } from './definitions/index.js' — loader.ts:L14"
      ],
      "typesInScope": [
        "SkillDefinition @ types.ts:19",
        "SkillFrontmatter @ loader.ts:26"
      ],
      "testMock": [
        "vi.mock('fs') — mock 返回 13 个 SKILL.md 文件",
        "vi.mock('os') — mock homedir 返回 '/tmp/test-home'",
        "const mockFiles = new Map([['/tmp/test-home/.studio/skills/goal-start/green-only-tdd/SKILL.md', '---\\nname: green-only-tdd\\n...\\n---\\n\\nprompt content']])"
      ],
      "dangerZones": [
        "删除 allSkillDefinitions 后，所有 import { allSkillDefinitions } 的地方会编译失败 — 确认只有 loader.ts 引用它",
        "loader.ts:L75 `private cache: SkillDefinition[] = allSkillDefinitions` — 改为 `[]`",
        "测试文件 mock fs 时需要覆盖新的目录结构（trigger/skillName/SKILL.md）"
      ],
      "verifiedAt": "2fe026c"
    },
    "codePatterns": [
      "参考 loader.test.ts:L1 — 现有的 vi.mock('fs') 模式",
      "参考 loader.test.ts 的 disk loading 测试 — 用于更新后的测试参考"
    ],
    "gotchas": [
      "⚠️ 删除 allSkillDefinitions 前必须确认所有 SKILL.md 文件已创建（p65-workflow-integration 完成）",
      "⚠️ loader.ts:L75 初始化 cache = allSkillDefinitions — 删除后改为 []，可能导致首次 load() 返回空（需 refreshCache 先执行）",
      "⚠️ 测试中 mockPrisma 可能需要更新（如果 DB fallback 逻辑变化）",
      "⚠️ stuck-recovery 的动态 prompt（含 stuckCount）在 .md 中是 {{stuckCount}} 占位符 — loadSkill 返回的 prompt 需要调用方替换"
    ],
    "modelTier": "fast",
    "modelTierReason": "主要是删除代码 + 更新测试，3 文件，逻辑简单（前提是前置组已完成）"
  }
]
```

## Files

- apps/api/src/modules/goals/pipeline-utils.ts
- apps/api/src/modules/goals/scheduler-dispatch.ts
- apps/api/src/modules/goals/scheduler-prompt.ts
- apps/api/src/modules/knowledge/improver-scheduler.service.ts
- harness/src/knowledge/code-analysis.ts
- harness/src/knowledge/index.ts
- packages/studio-skill/src/__tests__/loader.test.ts
- packages/studio-skill/src/definitions/index.ts
- packages/studio-skill/src/index.ts
- packages/studio-skill/src/loader.ts
- ~/.studio/skills/always/behaviour-constraints/SKILL.md
- ~/.studio/skills/always/knowledge-extraction/SKILL.md
- ~/.studio/skills/always/tool-risk/SKILL.md
- ~/.studio/skills/goal-start/contract-test-writing/SKILL.md
- ~/.studio/skills/goal-start/green-only-tdd/SKILL.md
- ~/.studio/skills/goal-start/impl/SKILL.md
- ~/.studio/skills/goal-start/req/SKILL.md
- ~/.studio/skills/goal-start/stuck-recovery/SKILL.md
- ~/.studio/skills/goal-start/sub-agent-workflow/SKILL.md
- ~/.studio/skills/integration/integration-merge/SKILL.md
- ~/.studio/skills/review/code-review/SKILL.md
- ~/.studio/skills/review/forensic-review/SKILL.md
- ~/.studio/skills/review/multi-stance-review/SKILL.md