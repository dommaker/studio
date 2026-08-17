---
id: "cmq8au91e002x11l1eeo5muns"
workUnitId: "cmq8aubta003p11l1o7emize0"
slug: "p5-p6-p6-5-pipeline-self-document-workflow-skills--ize0"
title: "P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一"
status: "stale"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["P5", "P6", "P6.5", "skill-system", "self-document", "pipeline-bootstrap", "AS-021"]
createdAt: "2026-06-10T16:44:47.809Z"
updatedAt: "2026-06-10T16:44:51.980Z"
---

# P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一

实现三个模块：P5 代码结构提取 + LLM 文档生成（harness 原语 + studio 编排），P6 三个 Workflow Skill（req/impl/review），P6.5 Skill 统一（SKILL.md 迁移 + loader 切换 + 硬编码删除 + proposal 生成）

<!-- TASK_TIER {"tier":"premium","reason":"跨 2 个仓库（harness + studio），新建 harness 原语 + studio 编排服务 + 13 个 SKILL.md 文件 + loader 重写 + definitions 删除，涉及 10+ 文件改动"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["KnowledgeStore interface — harness/src/knowledge/store.ts:L28-L41 (get/list/save/delete/update/rebuildIndex/snapshot)","FileKnowledgeStore class — harness/src/knowledge/store.ts:L48+ (file-based implementation)","KnowledgeEntry type — harness/src/knowledge/types.ts (full entry with id/type/title/content/maturity/layer)","KnowledgeType — harness/src/knowledge/types.ts ('model|decision|guideline|pitfall|process|architecture')","evolution-scheduler pattern — apps/api/src/modules/knowledge/evolution-scheduler.ts (timer-based, logger+try/catch)","knowledgeBus — apps/api/src/modules/knowledge/knowledge-bus.service.ts (search/formatSearchForPrompt/recordPattern)","SkillLoader class — packages/studio-skill/src/loader.ts:L72-L258 (load/get/formatForPrompt/getFullPrompt, disk>DB>hardcoded merge)","SKILLS_DIR — packages/studio-skill/src/loader.ts:L24 (process.env.SKILLS_DIR || ~/.studio/knowledge/skills/)","SKILLS_DIR (pipeline) — apps/api/src/modules/goals/pipeline-utils.ts:L33 (process.env.SKILLS_DIR || ~/.studio/skills/)","allSkillDefinitions — packages/studio-skill/src/definitions/index.ts (10 hardcoded skills)","SkillDefinition type — packages/studio-skill/src/types.ts:L19-L38 (id/name/description/trigger/agentTypes/tier/tools/prompt)","SkillTrigger type — packages/studio-skill/src/types.ts:L8-L15 (7 values)","skillLoaderService — apps/api/src/modules/skills/skill-loader.ts:L392 (singleton, session-aware)","parseFrontmatter — packages/studio-skill/src/loader.ts:L37-L57 (YAML frontmatter parser)","CodeStructure interface (draft) — docs/specs/arch/flywheel.md:L169-L75 (files/imports/exports/callGraph/gitFrequency)"],"unverified":["FileInfo/ImportGraph/ExportInfo/CallRelation/GitFrequency types — flywheel.md references but doesn't define","npx harness check CLI command — 需确认可执行","modelGateway.prompt() — 需确认 studio 中 LLM 调用接口存在"],"newRequired":["harness/src/knowledge/extraction.ts — 新模块：extractCodeStructure() + CodeStructure 类型","studio/apps/api/src/modules/knowledge/improver-scheduler.service.ts — 新模块：runSelfDoc()","13 个 SKILL.md 文件 — ~/.studio/skills/<trigger>/<name>/SKILL.md (10 迁移 + 3 新建)"]} -->

### Verified
- ✅ KnowledgeStore interface — harness/src/knowledge/store.ts:L28-L41 (get/list/save/delete/update/rebuildIndex/snapshot)
- ✅ FileKnowledgeStore class — harness/src/knowledge/store.ts:L48+ (file-based implementation)
- ✅ KnowledgeEntry type — harness/src/knowledge/types.ts (full entry with id/type/title/content/maturity/layer)
- ✅ KnowledgeType — harness/src/knowledge/types.ts ('model|decision|guideline|pitfall|process|architecture')
- ✅ evolution-scheduler pattern — apps/api/src/modules/knowledge/evolution-scheduler.ts (timer-based, logger+try/catch)
- ✅ knowledgeBus — apps/api/src/modules/knowledge/knowledge-bus.service.ts (search/formatSearchForPrompt/recordPattern)
- ✅ SkillLoader class — packages/studio-skill/src/loader.ts:L72-L258 (load/get/formatForPrompt/getFullPrompt, disk>DB>hardcoded merge)
- ✅ SKILLS_DIR — packages/studio-skill/src/loader.ts:L24 (process.env.SKILLS_DIR || ~/.studio/knowledge/skills/)
- ✅ SKILLS_DIR (pipeline) — apps/api/src/modules/goals/pipeline-utils.ts:L33 (process.env.SKILLS_DIR || ~/.studio/skills/)
- ✅ allSkillDefinitions — packages/studio-skill/src/definitions/index.ts (10 hardcoded skills)
- ✅ SkillDefinition type — packages/studio-skill/src/types.ts:L19-L38 (id/name/description/trigger/agentTypes/tier/tools/prompt)
- ✅ SkillTrigger type — packages/studio-skill/src/types.ts:L8-L15 (7 values)
- ✅ skillLoaderService — apps/api/src/modules/skills/skill-loader.ts:L392 (singleton, session-aware)
- ✅ parseFrontmatter — packages/studio-skill/src/loader.ts:L37-L57 (YAML frontmatter parser)
- ✅ CodeStructure interface (draft) — docs/specs/arch/flywheel.md:L169-L75 (files/imports/exports/callGraph/gitFrequency)

### ⚠️ Unverified
- ❌ FileInfo/ImportGraph/ExportInfo/CallRelation/GitFrequency types — flywheel.md references but doesn't define
- ❌ npx harness check CLI command — 需确认可执行
- ❌ modelGateway.prompt() — 需确认 studio 中 LLM 调用接口存在

### 🆕 New Required
- 📝 harness/src/knowledge/extraction.ts — 新模块：extractCodeStructure() + CodeStructure 类型
- 📝 studio/apps/api/src/modules/knowledge/improver-scheduler.service.ts — 新模块：runSelfDoc()
- 📝 13 个 SKILL.md 文件 — ~/.studio/skills/<trigger>/<name>/SKILL.md (10 迁移 + 3 新建)

## AC Groups

### p5-extract-code-structure
<!-- MODEL_TIER {"tier":"standard","reason":"新建模块 + 类型定义 + 正则提取逻辑，无外部依赖，但需要处理多种 TS 声明模式"} -->

#### 验收标准
- [ ] AC1: 在 harness/src/knowledge/extraction.ts 中定义 CodeStructure 接口（files: CodeFileInfo[], functions: CodeSymbol[], classes: CodeSymbol[], interfaces: CodeSymbol[], types: CodeSymbol[]）和辅助类型（CodeFileInfo { path, size, extension }，CodeSymbol { name, params?, returnType?, jsdoc?, location: { file, line } }）；导出 extractCodeStructure(dir: string): CodeStructure 函数；用 fs.readdirSync 递归遍历 dir 下 .ts/.js 文件（跳过 node_modules/.git/dist/build）；对每个文件用正则提取 export function/class/interface/type 声明的名称、参数、返回类型、JSDoc 注释（@param/@returns）；不做 AST 解析（正则足够）；文件读取失败时跳过该文件（不抛错）
- [ ] AC2: 在 harness/src/knowledge/__tests__/extraction.test.ts 中编写测试覆盖：正常目录提取函数/类/接口/类型、空目录返回空结构、不存在目录返回空结构、跳过 node_modules/.git/dist 目录、文件读取失败时跳过不抛错
- [ ] AC3: 在 harness/src/knowledge/index.ts 中导出 extractCodeStructure 和 CodeStructure 类型

#### 涉及文件
- harness/src/knowledge/extraction.ts
- harness/src/knowledge/__tests__/extraction.test.ts
- harness/src/knowledge/index.ts

### p5-improver-scheduler
<!-- MODEL_TIER {"tier":"standard","reason":"新建模块 + LLM 调用 + 知识写入，但逻辑清晰（遍历→提取→生成→写入），参考现有 evolution-scheduler 模式"} -->

#### 验收标准
- [ ] AC1: 在 apps/api/src/modules/knowledge/improver-scheduler.service.ts 中创建 ImproverScheduler 类；runSelfDoc(dirs: string[]) 方法遍历 dirs，对每个目录调用 extractCodeStructure（从 @dommaker/harness 导入或内联实现），将 CodeStructure 格式化为 Markdown prompt（列出函数/类/接口/类型的名称+签名+JSDoc），调用 modelGateway.prompt() 生成文档，用 knowledgeBus 写入 KnowledgeStore（type='architecture', layer='project'）+ 写入文件系统（<dir>/CONTEXT.md）；extractCodeStructure 不可用时（import 失败）降级为读取目录下现有 .ts/.js 文件名列表生成简化 prompt
- [ ] AC2: 在 ImproverScheduler 中添加 startScheduler() 方法，使用 setInterval 每小时执行一次 runSelfDoc；默认扫描目录从配置读取（process.env.SELFDOC_DIRS 或 ['apps/api/src/modules']）；startScheduler 在 knowledge 模块启动时调用（参考 evolution-scheduler.ts 的 startEvolution pattern）；错误不阻塞调度器（try/catch + logger.error）
- [ ] AC3: 在 apps/api/src/modules/knowledge/__tests__/improver-scheduler.test.ts 中编写测试覆盖：runSelfDoc 正常流程（extractCodeStructure → LLM → write）、extractCodeStructure 不可用时降级、LLM 调用失败时静默跳过、空目录列表时不做任何操作

#### 涉及文件
- apps/api/src/modules/knowledge/improver-scheduler.service.ts
- apps/api/src/modules/knowledge/__tests__/improver-scheduler.test.ts

#### 依赖: p5-extract-code-structure

### skill-md-migration-loader-swap
<!-- MODEL_TIER {"tier":"standard","reason":"13 个新文件 + 4 个文件重写 + definitions 删除，跨 2 个 packages + 1 个 app 模块，但逻辑清晰（文件迁移 + loader 重写 + SKILLS_DIR 统一）"} -->

#### 验收标准
- [ ] AC1: 在 ~/.studio/skills/ 下创建 13 个 SKILL.md 文件，目录结构为 <trigger>/<skill-name>/SKILL.md；10 个从现有 ~/.studio/knowledge/skills/ 迁移: green-only-tdd→goal-start/, contract-test-writing→goal-start/, stuck-recovery→goal-continue/, behaviour-constraints→always/, multi-stance-review→review/, forensic-review→review/, knowledge-extraction→knowledge-extract/, integration-merge→integration/, sub-agent-workflow→sub-agent/, tool-risk→always/；3 个新建 Workflow Skill: requirement-analysis→goal-start/req/SKILL.md（需求分析 prompt：读 spec→拆 AC→写契约测试→输出 RequirementsDocJson），implementation→goal-start/impl/SKILL.md（实现 prompt：读 AC→GREEN-only TDD→harness check→更新 progress），code-review→review/review/SKILL.md（代码审查 prompt：读 AC→逐条对照→检查质量门→输出审查报告）；每个文件包含 YAML frontmatter（name, version:1, description, agentTypes, tier）+ markdown body；迁移文件内容与现有 .md 一致，新建文件内容参考现有 skill prompt 模式（{{task}}, {{constraints}}, {{knowledgeContext}} 占位符）
- [ ] AC2: 在 packages/studio-skill/src/loader.ts 中重写 loadFromDisk()（L158-L171）和 loadAllFromDisk()（L177-L190）；改为扫描 SKILLS_DIR 下的 trigger 子目录（<SKILLS_DIR>/<trigger>/<name>/SKILL.md）而非 flat .md 文件；loadAllFromDisk 递归遍历 trigger 子目录，读取每个 SKILL.md 的 frontmatter；loadFromDisk 改为 loadFromSubdir(skillName) 搜索所有 trigger 子目录；更新 SKILLS_DIR 常量（L24）从 ~/.studio/knowledge/skills/ 改为 ~/.studio/skills/；保留 refreshCache() 的 disk > DB > hardcoded 合并优先级不变；保留 load/get/formatForPrompt/getFullPrompt 公开 API 不变
- [ ] AC3: 在 apps/api/src/modules/skills/skill-loader.ts 中更新 SKILLS_DIR（L65）为 ~/.studio/skills/；重写 loadSkillFromDisk()（L101-L113）和 loadAllSkillFiles()（L115-L129）改为扫描 trigger 子目录结构；loadForSession() 根据 trigger 参数只扫描对应子目录 + always/ 目录；移除 Prisma DB fallback（L177-L191 的 prisma.skill.findFirst 和 L287-L308 的 prisma.skill.findMany）；file-based 是唯一数据源；保留 sessionStates Map、LoadedSkill 接口、TIER_TOOL_ACCESS、getSessionPrompt、getSessionTools、clearSession 等 session 管理逻辑不变
- [ ] AC4: 删除 packages/studio-skill/src/definitions/index.ts 中的 10 个硬编码 SkillDefinition 对象（allSkillDefinitions 数组及所有定义）；文件保留为空 export {}；更新 packages/studio-skill/src/index.ts：移除 allSkillDefinitions 导出；保留 types.ts 的 SkillDefinition/SkillTrigger/SkillTier 类型导出不变——它们被 agent-context.ts、skill-loader.ts、session-manager.ts 消费
- [ ] AC5: 更新 apps/api/src/modules/goals/scheduler-prompt.ts 的 SKILLS_DIR（L16）为 ~/.studio/skills/；重写 loadSkillTemplate()（L36-L64）改为扫描 trigger 子目录结构（与 pipeline-utils.ts buildSkillPrompt 对齐）；或改为直接调用 pipeline-utils.buildSkillPrompt()（消除重复实现）；更新 buildSubAgentPrompt()（L142）中的硬编码 'sub-agent-workflow' skill name 路径验证

#### 涉及文件
- ~/.studio/skills/goal-start/green-only-tdd/SKILL.md
- ~/.studio/skills/goal-start/contract-test-writing/SKILL.md
- ~/.studio/skills/goal-start/req/SKILL.md
- ~/.studio/skills/goal-start/impl/SKILL.md
- ~/.studio/skills/goal-continue/stuck-recovery/SKILL.md
- ~/.studio/skills/always/behaviour-constraints/SKILL.md
- ~/.studio/skills/always/tool-risk/SKILL.md
- ~/.studio/skills/review/multi-stance-review/SKILL.md
- ~/.studio/skills/review/forensic-review/SKILL.md
- ~/.studio/skills/review/review/SKILL.md
- ~/.studio/skills/knowledge-extract/knowledge-extraction/SKILL.md
- ~/.studio/skills/integration/integration-merge/SKILL.md
- ~/.studio/skills/sub-agent/sub-agent-workflow/SKILL.md
- packages/studio-skill/src/loader.ts
- packages/studio-skill/src/definitions/index.ts
- packages/studio-skill/src/index.ts
- apps/api/src/modules/skills/skill-loader.ts
- apps/api/src/modules/goals/scheduler-prompt.ts

### proposal-skill-md-generation
<!-- MODEL_TIER {"tier":"fast","reason":"单文件修改 + 纯函数，无跨模块依赖"} -->

#### 验收标准
- [ ] AC1: 在 apps/api/src/modules/tools-std/skill-extraction.service.ts 的 reviewProposal() 方法中（L180+，approved=true 分支）；添加 SKILL.md 文件生成逻辑：根据 proposal 的 metadata（workflowType, name, description）确定 trigger 目录（调用 workflowTypeToTriggerDir()），创建 ~/.studio/skills/<trigger>/<name>/SKILL.md 文件；文件内容包含 YAML frontmatter（name, version:1, description, agentTypes:['executor'], tier:'standard', status:'draft'）+ markdown body（从 proposal.metadata.pattern 或默认模板生成）；文件已存在时跳过（不覆盖）；保留 reviewProposal 的现有逻辑（L180-L193: status 更新 + roleConfigService.addCapability）不变
- [ ] AC2: 在 skill-extraction.service.ts 中实现 workflowTypeToTriggerDir(workflowType: string): string 函数；将 workflowType 映射到 AS-021 的 trigger 目录名；映射规则: ci_fix/test_triage/config_change→'goal-start', pr_review→'review', doc_update/knowledge_curation→'always', architecture/refactor→'goal-start', skill_creation→'always', release_prep/changelog→'integration', unknown→'always'
- [ ] AC3: 在 apps/api/src/modules/tools-std/__tests__/skill-md-generation.test.ts 中编写测试覆盖：approved proposal 生成 SKILL.md 文件、workflowTypeToTriggerDir 映射正确、文件已存在时跳过不覆盖

#### 涉及文件
- apps/api/src/modules/tools-std/skill-extraction.service.ts
- apps/api/src/modules/tools-std/__tests__/skill-md-generation.test.ts

#### 依赖: skill-md-migration-loader-swap
## 约束
- SKILL.md 文件格式必须对齐 AS-021 spec: YAML frontmatter (name, version, description) + markdown body
- SKILLS_DIR 路径统一为 ~/.studio/skills/（对齐 AS-021 spec L128），从 ~/.studio/knowledge/skills/ 迁移
- SkillLoader 和 SkillLoaderService 的公共 API 必须保持向后兼容（load, formatForPrompt, getFullPrompt, loadSkill, getSessionPrompt, getSessionTools）
- 不删除 types.ts 的 SkillDefinition/SkillTrigger/SkillTier 类型——它们被 5+ 个消费者使用
- 不删除 skillLoader 和 skillLoaderService 单例导出——它们被 agent-context.ts、session-manager.ts、MCP tools.ts 导入
- harness extractCodeStructure 用正则而非 AST——MVP 限制，后续可升级
- Prisma Skill model 和 SkillProposal model 不删除（proposal 流程仍写 DB），但 loader 不再从 DB 读取
- 3 个新 Workflow Skill 的 prompt 必须包含 {{task}}, {{constraints}}, {{knowledgeContext}} 占位符

## AC Groups

```json
[
  {
    "id": "p5-extract-code-structure",
    "targetRepo": "harness",
    "acs": [
      "AC1: 在 harness/src/knowledge/extraction.ts 中定义 CodeStructure 接口（files: CodeFileInfo[], functions: CodeSymbol[], classes: CodeSymbol[], interfaces: CodeSymbol[], types: CodeSymbol[]）和辅助类型（CodeFileInfo { path, size, extension }，CodeSymbol { name, params?, returnType?, jsdoc?, location: { file, line } }）；导出 extractCodeStructure(dir: string): CodeStructure 函数；用 fs.readdirSync 递归遍历 dir 下 .ts/.js 文件（跳过 node_modules/.git/dist/build）；对每个文件用正则提取 export function/class/interface/type 声明的名称、参数、返回类型、JSDoc 注释（@param/@returns）；不做 AST 解析（正则足够）；文件读取失败时跳过该文件（不抛错）",
      "AC2: 在 harness/src/knowledge/__tests__/extraction.test.ts 中编写测试覆盖：正常目录提取函数/类/接口/类型、空目录返回空结构、不存在目录返回空结构、跳过 node_modules/.git/dist 目录、文件读取失败时跳过不抛错",
      "AC3: 在 harness/src/knowledge/index.ts 中导出 extractCodeStructure 和 CodeStructure 类型"
    ],
    "files": [
      "harness/src/knowledge/extraction.ts",
      "harness/src/knowledge/__tests__/extraction.test.ts",
      "harness/src/knowledge/index.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. 新建 extraction.ts，不修改 store.ts（职责分离）。2. 正则提取模式：export function name( → 函数名+参数，export class name → 类名，export interface name → 接口名，export type name → 类型名。3. JSDoc 提取：在声明行前查找 /** ... */ 块。4. 返回类型：从函数签名 `): ReturnType` 中正则提取。5. index.ts 追加导出（不删现有导出）。参考 harness/src/knowledge/store.ts 的文件操作模式。",
    "architectureContext": {
      "functions": [
        "extractCodeStructure(dir: string): CodeStructure — harness/src/knowledge/extraction.ts (新建)",
        "CodeStructure { files: CodeFileInfo[], functions: CodeSymbol[], classes: CodeSymbol[], interfaces: CodeSymbol[], types: CodeSymbol[] } — extraction.ts (新建)",
        "FileKnowledgeStore.readEntriesFromDisk() — store.ts:L37 (参考文件遍历模式)"
      ],
      "callChain": "improver-scheduler.service.ts → extractCodeStructure(dir) → CodeStructure JSON → LLM prompt → knowledgeBus.write()",
      "imports": [
        "import * as fs from 'fs'",
        "import * as path from 'path'"
      ],
      "typesInScope": [
        "KnowledgeEntry { id, type, title, content, maturity, layer, contributors, tags, ... } @ types.ts",
        "KnowledgeType = 'model' | 'decision' | 'guideline' | 'pitfall' | 'process' | 'architecture' @ types.ts"
      ],
      "testMock": [
        "vi.mock('fs', async () => ({ ...await vi.importActual('fs'), readdirSync: vi.fn(), readFileSync: vi.fn() }))",
        "const MOCK_TS_FILE = 'export function hello(name: string): void { console.log(name) }'"
      ],
      "dangerZones": [
        "store.ts 是现有文件 — 不修改，extraction.ts 是新文件",
        "types.ts 添加新类型时不要修改现有类型定义",
        "正则提取有局限（多行签名、泛型嵌套可能漏提）— MVP 足够，后续可升级 AST"
      ],
      "verifiedAt": "2026-06-11 (analysis)"
    },
    "codePatterns": [
      "参考文件遍历: store.ts readEntriesFromDisk() — readdirSync + filter + 跳过隐藏目录",
      "参考类型导出: types.ts KnowledgeEntry interface 定义模式",
      "参考 index.ts 导出: harness/src/knowledge/index.ts 现有 re-export 模式"
    ],
    "gotchas": [
      "⚠ 不修改 store.ts — extractCodeStructure 是独立原语，不混入存储层",
      "⚠ 正则不处理多行函数签名 — MVP 限制，文档中记录",
      "⚠ 跳过 node_modules/.git/dist/build — 硬编码排除列表"
    ],
    "modelTier": "standard",
    "modelTierReason": "新建模块 + 类型定义 + 正则提取逻辑，无外部依赖，但需要处理多种 TS 声明模式"
  },
  {
    "id": "p5-improver-scheduler",
    "targetRepo": "studio",
    "acs": [
      "AC1: 在 apps/api/src/modules/knowledge/improver-scheduler.service.ts 中创建 ImproverScheduler 类；runSelfDoc(dirs: string[]) 方法遍历 dirs，对每个目录调用 extractCodeStructure（从 @dommaker/harness 导入或内联实现），将 CodeStructure 格式化为 Markdown prompt（列出函数/类/接口/类型的名称+签名+JSDoc），调用 modelGateway.prompt() 生成文档，用 knowledgeBus 写入 KnowledgeStore（type='architecture', layer='project'）+ 写入文件系统（<dir>/CONTEXT.md）；extractCodeStructure 不可用时（import 失败）降级为读取目录下现有 .ts/.js 文件名列表生成简化 prompt",
      "AC2: 在 ImproverScheduler 中添加 startScheduler() 方法，使用 setInterval 每小时执行一次 runSelfDoc；默认扫描目录从配置读取（process.env.SELFDOC_DIRS 或 ['apps/api/src/modules']）；startScheduler 在 knowledge 模块启动时调用（参考 evolution-scheduler.ts 的 startEvolution pattern）；错误不阻塞调度器（try/catch + logger.error）",
      "AC3: 在 apps/api/src/modules/knowledge/__tests__/improver-scheduler.test.ts 中编写测试覆盖：runSelfDoc 正常流程（extractCodeStructure → LLM → write）、extractCodeStructure 不可用时降级、LLM 调用失败时静默跳过、空目录列表时不做任何操作"
    ],
    "files": [
      "apps/api/src/modules/knowledge/improver-scheduler.service.ts",
      "apps/api/src/modules/knowledge/__tests__/improver-scheduler.test.ts"
    ],
    "dependencies": [
      "p5-extract-code-structure"
    ],
    "implementationNotes": "1. 新建 improver-scheduler.service.ts，参考 evolution-scheduler.ts 的 timer + try/catch + logger 模式。2. extractCodeStructure 可能从 @dommaker/harness 导入（P5a 完成后），或内联简化版（正则提取文件名+export 声明）。3. modelGateway 需确认 studio 中的 LLM 调用接口——如果不存在，用 placeholder 注释标记。4. knowledgeBus.write() 需确认写入 API——参考 knowledge-bus.service.ts。5. CONTEXT.md 格式：简短目录索引（≤2KB），不是完整文档。",
    "architectureContext": {
      "functions": [
        "ImproverScheduler.runSelfDoc(dirs: string[]): Promise<void> — 新建",
        "ImproverScheduler.startScheduler(): void — 新建",
        "extractCodeStructure(dir: string): CodeStructure — 来自 harness (P5a)",
        "knowledgeBus.search() — knowledge-bus.service.ts (已有)",
        "knowledgeBus.recordPattern() — knowledge-bus.service.ts (已有)"
      ],
      "callChain": "startEvolution() [module startup] → ImproverScheduler.startScheduler() → setInterval(1h) → runSelfDoc(dirs) → extractCodeStructure() → modelGateway.prompt() → knowledgeBus.write() + fs.writeFileSync(CONTEXT.md)",
      "imports": [
        "import { logger } from '@dommaker/studio-shared'",
        "import { knowledgeBus } from './knowledge-bus.service.js'",
        "import * as fs from 'fs'",
        "import * as path from 'path'"
      ],
      "typesInScope": [
        "CodeStructure { files, functions, classes, interfaces, types } @ harness extraction.ts (P5a)",
        "KnowledgeEntry { id, type, title, content, maturity, layer, ... } @ harness types.ts"
      ],
      "testMock": [
        "vi.mock('@dommaker/harness', () => ({ extractCodeStructure: vi.fn().mockReturnValue({ files: [], functions: [], classes: [], interfaces: [], types: [] }) }))",
        "vi.mock('./knowledge-bus.service.js', () => ({ knowledgeBus: { write: vi.fn(), search: vi.fn().mockReturnValue([]) } }))",
        "vi.mock('../../daemon/studio-daemon.js', () => ({ daemon: { getModelGateway: vi.fn().mockReturnValue({ prompt: vi.fn().mockResolvedValue('# Generated Doc') }) } }))"
      ],
      "dangerZones": [
        "evolution-scheduler.ts 是现有调度器 — 不修改，improver-scheduler 是独立模块",
        "modelGateway 接口需验证 — 如果 studio 没有统一的 LLM gateway，用 placeholder",
        "knowledgeBus.write() 接口需验证 — 可能是 knowledgeService 的其他方法"
      ],
      "verifiedAt": "2026-06-11 (analysis)"
    },
    "codePatterns": [
      "参考调度器模式: evolution-scheduler.ts (setInterval + try/catch + logger)",
      "参考知识写入: knowledge-bus.service.ts (search/recordPattern)",
      "参考 LLM 调用: 需确认 studio 中 modelGateway 的实际路径"
    ],
    "gotchas": [
      "⚠ modelGateway 接口未确认 — 如果不存在，先创建 placeholder 接口",
      "⚠ extractCodeStructure 依赖 P5a 完成 — 可用内联简化版先实现",
      "⚠ CONTEXT.md 格式 ≤2KB — 不要写完整 API 文档，只写目录索引",
      "⚠ 不修改 evolution-scheduler.ts — 两个调度器独立共存"
    ],
    "modelTier": "standard",
    "modelTierReason": "新建模块 + LLM 调用 + 知识写入，但逻辑清晰（遍历→提取→生成→写入），参考现有 evolution-scheduler 模式"
  },
  {
    "id": "skill-md-migration-loader-swap",
    "targetRepo": "studio",
    "acs": [
      "AC1: 在 ~/.studio/skills/ 下创建 13 个 SKILL.md 文件，目录结构为 <trigger>/<skill-name>/SKILL.md；10 个从现有 ~/.studio/knowledge/skills/ 迁移: green-only-tdd→goal-start/, contract-test-writing→goal-start/, stuck-recovery→goal-continue/, behaviour-constraints→always/, multi-stance-review→review/, forensic-review→review/, knowledge-extraction→knowledge-extract/, integration-merge→integration/, sub-agent-workflow→sub-agent/, tool-risk→always/；3 个新建 Workflow Skill: requirement-analysis→goal-start/req/SKILL.md（需求分析 prompt：读 spec→拆 AC→写契约测试→输出 RequirementsDocJson），implementation→goal-start/impl/SKILL.md（实现 prompt：读 AC→GREEN-only TDD→harness check→更新 progress），code-review→review/review/SKILL.md（代码审查 prompt：读 AC→逐条对照→检查质量门→输出审查报告）；每个文件包含 YAML frontmatter（name, version:1, description, agentTypes, tier）+ markdown body；迁移文件内容与现有 .md 一致，新建文件内容参考现有 skill prompt 模式（{{task}}, {{constraints}}, {{knowledgeContext}} 占位符）",
      "AC2: 在 packages/studio-skill/src/loader.ts 中重写 loadFromDisk()（L158-L171）和 loadAllFromDisk()（L177-L190）；改为扫描 SKILLS_DIR 下的 trigger 子目录（<SKILLS_DIR>/<trigger>/<name>/SKILL.md）而非 flat .md 文件；loadAllFromDisk 递归遍历 trigger 子目录，读取每个 SKILL.md 的 frontmatter；loadFromDisk 改为 loadFromSubdir(skillName) 搜索所有 trigger 子目录；更新 SKILLS_DIR 常量（L24）从 ~/.studio/knowledge/skills/ 改为 ~/.studio/skills/；保留 refreshCache() 的 disk > DB > hardcoded 合并优先级不变；保留 load/get/formatForPrompt/getFullPrompt 公开 API 不变",
      "AC3: 在 apps/api/src/modules/skills/skill-loader.ts 中更新 SKILLS_DIR（L65）为 ~/.studio/skills/；重写 loadSkillFromDisk()（L101-L113）和 loadAllSkillFiles()（L115-L129）改为扫描 trigger 子目录结构；loadForSession() 根据 trigger 参数只扫描对应子目录 + always/ 目录；移除 Prisma DB fallback（L177-L191 的 prisma.skill.findFirst 和 L287-L308 的 prisma.skill.findMany）；file-based 是唯一数据源；保留 sessionStates Map、LoadedSkill 接口、TIER_TOOL_ACCESS、getSessionPrompt、getSessionTools、clearSession 等 session 管理逻辑不变",
      "AC4: 删除 packages/studio-skill/src/definitions/index.ts 中的 10 个硬编码 SkillDefinition 对象（allSkillDefinitions 数组及所有定义）；文件保留为空 export {}；更新 packages/studio-skill/src/index.ts：移除 allSkillDefinitions 导出；保留 types.ts 的 SkillDefinition/SkillTrigger/SkillTier 类型导出不变——它们被 agent-context.ts、skill-loader.ts、session-manager.ts 消费",
      "AC5: 更新 apps/api/src/modules/goals/scheduler-prompt.ts 的 SKILLS_DIR（L16）为 ~/.studio/skills/；重写 loadSkillTemplate()（L36-L64）改为扫描 trigger 子目录结构（与 pipeline-utils.ts buildSkillPrompt 对齐）；或改为直接调用 pipeline-utils.buildSkillPrompt()（消除重复实现）；更新 buildSubAgentPrompt()（L142）中的硬编码 'sub-agent-workflow' skill name 路径验证"
    ],
    "files": [
      "~/.studio/skills/goal-start/green-only-tdd/SKILL.md",
      "~/.studio/skills/goal-start/contract-test-writing/SKILL.md",
      "~/.studio/skills/goal-start/req/SKILL.md",
      "~/.studio/skills/goal-start/impl/SKILL.md",
      "~/.studio/skills/goal-continue/stuck-recovery/SKILL.md",
      "~/.studio/skills/always/behaviour-constraints/SKILL.md",
      "~/.studio/skills/always/tool-risk/SKILL.md",
      "~/.studio/skills/review/multi-stance-review/SKILL.md",
      "~/.studio/skills/review/forensic-review/SKILL.md",
      "~/.studio/skills/review/review/SKILL.md",
      "~/.studio/skills/knowledge-extract/knowledge-extraction/SKILL.md",
      "~/.studio/skills/integration/integration-merge/SKILL.md",
      "~/.studio/skills/sub-agent/sub-agent-workflow/SKILL.md",
      "packages/studio-skill/src/loader.ts",
      "packages/studio-skill/src/definitions/index.ts",
      "packages/studio-skill/src/index.ts",
      "apps/api/src/modules/skills/skill-loader.ts",
      "apps/api/src/modules/goals/scheduler-prompt.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. 先创建 13 个 SKILL.md 文件（AC1）。2. 提取共享 parseFrontmatter 函数（当前 skill-loader.ts L78-L99 和 loader.ts L37-L57 有重复实现）。3. 重写 package loader 的 loadFromDisk/loadAllFromDisk（AC2）。4. 重写 API skill-loader 的文件加载逻辑（AC3），移除 Prisma fallback。5. 删除 definitions/index.ts（AC4）。6. 统一 SKILLS_DIR + 更新 scheduler-prompt.ts（AC5）。关键决策：SKILLS_DIR 统一为 ~/.studio/skills/（对齐 AS-021 spec），需同步更新 loader.ts:L24、skill-loader.ts:L65、scheduler-prompt.ts:L16、pipeline-utils.ts:L33 四处定义。3 个新 Workflow Skill（req/impl/review）的 prompt 内容参考现有 green-only-tdd.md 和 contract-test-writing.md 的格式。",
    "architectureContext": {
      "functions": [
        "SkillLoader.loadFromDisk(skillName: string): SkillDefinition | null — loader.ts:L158 (要重写为子目录扫描)",
        "SkillLoader.loadAllFromDisk(): SkillDefinition[] — loader.ts:L177 (要重写为子目录扫描)",
        "SkillLoader.refreshCache(): void — loader.ts:L205 (保留 disk>DB>hardcoded 合并逻辑)",
        "SkillLoader.load(options: LoadOptions): SkillDefinition[] — loader.ts:L100 (保留不变)",
        "SkillLoaderService.loadSkillFromDisk(skillName: string) — skill-loader.ts:L101 (要重写)",
        "SkillLoaderService.loadAllSkillFiles() — skill-loader.ts:L115 (要重写)",
        "SkillLoaderService.loadForSession(options) — skill-loader.ts:L263 (保留 session 管理逻辑)",
        "loadSkillTemplate(skillName: string) — scheduler-prompt.ts:L36 (要重写或移除)",
        "buildSkillPrompt(skillName, vars) — pipeline-utils.ts:L173 (已实现，可复用)",
        "parseFrontmatter(content: string) — loader.ts:L37 (共享函数，需统一)"
      ],
      "callChain": "agent-runner.ts → skillLoader.load({trigger}) → maybeRefreshCache() → refreshCache() → loadAllFromDisk() [trigger子目录扫描] + prisma.skill.findMany() [DB] + allSkillDefinitions [hardcoded]. scheduler-dispatch.ts → buildSubAgentPrompt() → buildSkillPrompt() → loadSkillTemplate() [trigger子目录扫描]",
      "imports": [
        "import fs from 'fs'",
        "import path from 'path'",
        "import os from 'os'",
        "import type { SkillDefinition, SkillTrigger, SkillTier } from './types.js'"
      ],
      "typesInScope": [
        "SkillDefinition { id, name, description, trigger, agentTypes, tier, requires?, tools?, prompt } @ types.ts:L19-L38",
        "SkillTrigger = 'goal_start' | 'goal_continue' | 'review' | 'knowledge_extract' | 'integration' | 'sub_agent' | 'always' @ types.ts:L8-L15",
        "SkillTier = 'fast' | 'standard' | 'premium' @ types.ts:L17",
        "LoadOptions { trigger, agentType?, tier?, exclude? } @ loader.ts:L16-L21",
        "LoadedSkill { skillId, name, prompt, tools, tier, loadedAt } @ skill-loader.ts:L21-L28"
      ],
      "testMock": [
        "vi.mock('fs', async () => ({ ...await vi.importActual('fs'), existsSync: vi.fn(), readFileSync: vi.fn(), readdirSync: vi.fn() }))",
        "vi.mock('os', () => ({ default: { homedir: vi.fn().mockReturnValue('/tmp/test-home') } }))",
        "const MOCK_SKILL_MD = '---\\nname: test-skill\\nversion: 1\\ndescription: Test\\nagentTypes: [executor]\\ntier: fast\\n---\\n## Prompt'"
      ],
      "dangerZones": [
        "loader.ts L141: skillLoader 单例 — 被 agent-context.ts:L69, session-manager.ts:L20, review-agent.service.ts:L81 导入，不修改导出",
        "skill-loader.ts L392: skillLoaderService 单例 — 被 MCP tools.ts:L1032 导入",
        "skill-loader.ts L211-L218: studioEvent.create skill_used 事件 — 保留，OKR 指标数据源",
        "types.ts SkillDefinition/SkillTrigger/SkillTier 类型 — 不删除，5+ 消费者",
        "scheduler-prompt.ts L142: buildSubAgentPrompt 硬编码 'sub-agent-workflow' — 路径变化后验证"
      ],
      "verifiedAt": "2026-06-11 (analysis)"
    },
    "codePatterns": [
      "参考 frontmatter 解析: loader.ts:L37-L57 parseFrontmatter()",
      "参考子目录扫描: pipeline-utils.ts:L181-L192 buildSkillPrompt() readdirSync withFileTypes",
      "参考 SKILL.md 格式: ~/.studio/knowledge/skills/green-only-tdd.md (frontmatter + prompt + placeholders)",
      "参考 loader 测试: packages/studio-skill/src/__tests__/loader.test.ts"
    ],
    "gotchas": [
      "⚠ 不可删除: SkillDefinition/SkillTrigger/SkillTier 类型 — 消费者: agent-context.ts, skill-loader.ts, session-manager.ts",
      "⚠ 不可删除: skillLoader 单例导出 — 消费者: agent-context.ts:L69, session-manager.ts:L20",
      "⚠ 不可删除: skillLoaderService 单例导出 — 消费者: MCP tools.ts:L1032",
      "⚠ 不可修改: studioEvent.create skill_used 事件 — 下游: OKR metrics",
      "⚠ SKILLS_DIR 四处定义必须同步修改: loader.ts:L24, skill-loader.ts:L65, scheduler-prompt.ts:L16, pipeline-utils.ts:L33",
      "⚠ 旧目录 ~/.studio/knowledge/skills/*.md 迁移后可删除（或保留做兼容）",
      "⚠ .md（无名文件）和 proxy.md 不迁移 — 异常/非标准文件"
    ],
    "modelTier": "standard",
    "modelTierReason": "13 个新文件 + 4 个文件重写 + definitions 删除，跨 2 个 packages + 1 个 app 模块，但逻辑清晰（文件迁移 + loader 重写 + SKILLS_DIR 统一）"
  },
  {
    "id": "proposal-skill-md-generation",
    "targetRepo": "studio",
    "acs": [
      "AC1: 在 apps/api/src/modules/tools-std/skill-extraction.service.ts 的 reviewProposal() 方法中（L180+，approved=true 分支）；添加 SKILL.md 文件生成逻辑：根据 proposal 的 metadata（workflowType, name, description）确定 trigger 目录（调用 workflowTypeToTriggerDir()），创建 ~/.studio/skills/<trigger>/<name>/SKILL.md 文件；文件内容包含 YAML frontmatter（name, version:1, description, agentTypes:['executor'], tier:'standard', status:'draft'）+ markdown body（从 proposal.metadata.pattern 或默认模板生成）；文件已存在时跳过（不覆盖）；保留 reviewProposal 的现有逻辑（L180-L193: status 更新 + roleConfigService.addCapability）不变",
      "AC2: 在 skill-extraction.service.ts 中实现 workflowTypeToTriggerDir(workflowType: string): string 函数；将 workflowType 映射到 AS-021 的 trigger 目录名；映射规则: ci_fix/test_triage/config_change→'goal-start', pr_review→'review', doc_update/knowledge_curation→'always', architecture/refactor→'goal-start', skill_creation→'always', release_prep/changelog→'integration', unknown→'always'",
      "AC3: 在 apps/api/src/modules/tools-std/__tests__/skill-md-generation.test.ts 中编写测试覆盖：approved proposal 生成 SKILL.md 文件、workflowTypeToTriggerDir 映射正确、文件已存在时跳过不覆盖"
    ],
    "files": [
      "apps/api/src/modules/tools-std/skill-extraction.service.ts",
      "apps/api/src/modules/tools-std/__tests__/skill-md-generation.test.ts"
    ],
    "dependencies": [
      "skill-md-migration-loader-swap"
    ],
    "implementationNotes": "1. reviewProposal() 的 approved 分支（L180+）目前更新 Skill.status + addCapability。在其后追加文件生成。2. 使用 fs.mkdirSync({recursive: true}) + fs.writeFileSync 创建文件。3. workflowTypeToTriggerDir 是纯函数。4. SKILL.md 内容格式对齐 AC1 创建的文件。关键决策：proposal 生成的 skill status='draft'，文件已存在时不覆盖。",
    "architectureContext": {
      "functions": [
        "reviewProposal(proposalId: string, approved: boolean) @ skill-extraction.service.ts:L180",
        "workflowTypeToTriggerDir(workflowType: string): string @ skill-extraction.service.ts (新建)"
      ],
      "callChain": "POST /skills/proposals/:id/approve → reviewProposal(id, true) → update Skill.status → roleConfigService.addCapability() → [新增] write SKILL.md file",
      "imports": [
        "import * as fs from 'fs'",
        "import * as path from 'path'",
        "import { SKILLS_DIR } from '../skills/skill-loader.js'"
      ],
      "typesInScope": [
        "SkillProposal { id, skillId, status, proposedBy, summary, proposedAt, reviewedAt } @ schema.prisma",
        "Skill { id, name, description, status, category, metadata, trigger, agentTypes, tier } @ schema.prisma"
      ],
      "testMock": [
        "vi.mock('@dommaker/studio-prisma', () => ({ prisma: { skill: { findFirst: vi.fn() }, skillProposal: { findFirst: vi.fn(), update: vi.fn() } } }))",
        "vi.mock('fs', async () => ({ ...await vi.importActual('fs'), mkdirSync: vi.fn(), writeFileSync: vi.fn(), existsSync: vi.fn().mockReturnValue(false) }))"
      ],
      "dangerZones": [
        "skill-extraction.service.ts L180-L193: reviewProposal 现有逻辑 — 不修改，只在其后追加",
        "SKILLS_DIR 路径必须与 skill-md-migration-loader-swap 组同步"
      ],
      "verifiedAt": "2026-06-11 (analysis)"
    },
    "codePatterns": [
      "参考 proposal 审批: skill-extraction.service.ts:L180-L193 reviewProposal approved 分支",
      "参考文件写入: pipeline-utils.ts buildSkillPrompt 的 SKILL.md 读取模式"
    ],
    "gotchas": [
      "⚠ 不可修改: reviewProposal 的 status 更新 + addCapability 逻辑",
      "⚠ 生成的 SKILL.md status 必须是 'draft'",
      "⚠ 文件已存在时必须跳过（fs.existsSync 检查）"
    ],
    "modelTier": "fast",
    "modelTierReason": "单文件修改 + 纯函数，无跨模块依赖"
  }
]
```

## Files

- apps/api/src/modules/goals/scheduler-prompt.ts
- apps/api/src/modules/knowledge/__tests__/improver-scheduler.test.ts
- apps/api/src/modules/knowledge/improver-scheduler.service.ts
- apps/api/src/modules/skills/skill-loader.ts
- apps/api/src/modules/tools-std/__tests__/skill-md-generation.test.ts
- apps/api/src/modules/tools-std/skill-extraction.service.ts
- harness/src/knowledge/__tests__/extraction.test.ts
- harness/src/knowledge/extraction.ts
- harness/src/knowledge/index.ts
- packages/studio-skill/src/definitions/index.ts
- packages/studio-skill/src/index.ts
- packages/studio-skill/src/loader.ts
- ~/.studio/skills/always/behaviour-constraints/SKILL.md
- ~/.studio/skills/always/tool-risk/SKILL.md
- ~/.studio/skills/goal-continue/stuck-recovery/SKILL.md
- ~/.studio/skills/goal-start/contract-test-writing/SKILL.md
- ~/.studio/skills/goal-start/green-only-tdd/SKILL.md
- ~/.studio/skills/goal-start/impl/SKILL.md
- ~/.studio/skills/goal-start/req/SKILL.md
- ~/.studio/skills/integration/integration-merge/SKILL.md
- ~/.studio/skills/knowledge-extract/knowledge-extraction/SKILL.md
- ~/.studio/skills/review/forensic-review/SKILL.md
- ~/.studio/skills/review/multi-stance-review/SKILL.md
- ~/.studio/skills/review/review/SKILL.md
- ~/.studio/skills/sub-agent/sub-agent-workflow/SKILL.md