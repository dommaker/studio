---
id: "sdd-1785165386520-tgxebl"
slug: "p5-p6-p6-5-pipeline-self-document-workflow-skills--ize0"
title: "P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一"
status: "stale"
version: 16
designVersion: 16
parentId: "sdd-1785145839859-pmk46l"
changeType: "L3"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["P5", "P6", "P6.5", "skill-system", "self-document", "pipeline-bootstrap", "AS-021"]
createdAt: "2026-06-10T16:44:47.809Z"
updatedAt: "2026-07-27T15:16:26.520Z"
---

# P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一

实现三个模块：P5 代码结构提取 + LLM 文档生成（harness 原语 + studio 编排），P6 三个 Workflow Skill（req/impl/review），P6.5 Skill 统一（SKILL.md 迁移 + loader 切换 + 硬编码删除 + proposal 生成）

<!-- TASK_TIER {"tier":"premium","reason":"跨 2 个仓库（harness + studio），新建 harness 原语 + studio 编排服务 + 13 个 SKILL.md 文件 + loader 重写 + definitions 删除，涉及 10+ 文件改动"} -->

## Architecture Context

### p5-extract-code-structure

**Functions**
- extractCodeStructure(dir: string): CodeStructure — harness/src/knowledge/extraction.ts (新建)
- CodeStructure { files: CodeFileInfo[], functions: CodeSymbol[], classes: CodeSymbol[], interfaces: CodeSymbol[], types: CodeSymbol[] } — extraction.ts (新建)
- FileKnowledgeStore.readEntriesFromDisk() — store.ts:L37 (参考文件遍历模式)

**Call Chain**
improver-scheduler.service.ts → extractCodeStructure(dir) → CodeStructure JSON → LLM prompt → knowledgeBus.write()

**Imports**
- import * as fs from 'fs'
- import * as path from 'path'

**Types in Scope**
- KnowledgeEntry { id, type, title, content, maturity, layer, contributors, tags, ... } @ types.ts
- KnowledgeType = 'model' | 'decision' | 'guideline' | 'pitfall' | 'process' | 'architecture' @ types.ts

**Test Mocks**
- vi.mock('fs', async () => ({ ...await vi.importActual('fs'), readdirSync: vi.fn(), readFileSync: vi.fn() }))
- const MOCK_TS_FILE = 'export function hello(name: string): void { console.log(name) }'

**Danger Zones**
- store.ts 是现有文件 — 不修改，extraction.ts 是新文件
- types.ts 添加新类型时不要修改现有类型定义
- 正则提取有局限（多行签名、泛型嵌套可能漏提）— MVP 足够，后续可升级 AST

### p5-improver-scheduler

**Functions**
- ImproverScheduler.runSelfDoc(dirs: string[]): Promise<void> — 新建
- ImproverScheduler.startScheduler(): void — 新建
- extractCodeStructure(dir: string): CodeStructure — 来自 harness (P5a)
- knowledgeBus.search() — knowledge-bus.service.ts (已有)
- knowledgeBus.recordPattern() — knowledge-bus.service.ts (已有)

**Call Chain**
startEvolution() [module startup] → ImproverScheduler.startScheduler() → setInterval(1h) → runSelfDoc(dirs) → extractCodeStructure() → modelGateway.prompt() → knowledgeBus.write() + fs.writeFileSync(CONTEXT.md)

**Imports**
- import { logger } from '@dommaker/studio-shared'
- import { knowledgeBus } from './knowledge-bus.service.js'
- import * as fs from 'fs'
- import * as path from 'path'

**Types in Scope**
- CodeStructure { files, functions, classes, interfaces, types } @ harness extraction.ts (P5a)
- KnowledgeEntry { id, type, title, content, maturity, layer, ... } @ harness types.ts

**Test Mocks**
- vi.mock('@dommaker/harness', () => ({ extractCodeStructure: vi.fn().mockReturnValue({ files: [], functions: [], classes: [], interfaces: [], types: [] }) }))
- vi.mock('./knowledge-bus.service.js', () => ({ knowledgeBus: { write: vi.fn(), search: vi.fn().mockReturnValue([]) } }))
- vi.mock('../../daemon/studio-daemon.js', () => ({ daemon: { getModelGateway: vi.fn().mockReturnValue({ prompt: vi.fn().mockResolvedValue('# Generated Doc') }) } }))

**Danger Zones**
- evolution-scheduler.ts 是现有调度器 — 不修改，improver-scheduler 是独立模块
- modelGateway 接口需验证 — 如果 studio 没有统一的 LLM gateway，用 placeholder
- knowledgeBus.write() 接口需验证 — 可能是 knowledgeService 的其他方法

### skill-md-migration-loader-swap

**Functions**
- SkillLoader.loadFromDisk(skillName: string): SkillDefinition | null — loader.ts:L158 (要重写为子目录扫描)
- SkillLoader.loadAllFromDisk(): SkillDefinition[] — loader.ts:L177 (要重写为子目录扫描)
- SkillLoader.refreshCache(): void — loader.ts:L205 (保留 disk>DB>hardcoded 合并逻辑)
- SkillLoader.load(options: LoadOptions): SkillDefinition[] — loader.ts:L100 (保留不变)
- SkillLoaderService.loadSkillFromDisk(skillName: string) — skill-loader.ts:L101 (要重写)
- SkillLoaderService.loadAllSkillFiles() — skill-loader.ts:L115 (要重写)
- SkillLoaderService.loadForSession(options) — skill-loader.ts:L263 (保留 session 管理逻辑)
- loadSkillTemplate(skillName: string) — scheduler-prompt.ts:L36 (要重写或移除)
- buildSkillPrompt(skillName, vars) — pipeline-utils.ts:L173 (已实现，可复用)
- parseFrontmatter(content: string) — loader.ts:L37 (共享函数，需统一)

**Call Chain**
agent-runner.ts → skillLoader.load({trigger}) → maybeRefreshCache() → refreshCache() → loadAllFromDisk() [trigger子目录扫描] + prisma.skill.findMany() [DB] + allSkillDefinitions [hardcoded]. scheduler-dispatch.ts → buildSubAgentPrompt() → buildSkillPrompt() → loadSkillTemplate() [trigger子目录扫描]

**Imports**
- import fs from 'fs'
- import path from 'path'
- import os from 'os'
- import type { SkillDefinition, SkillTrigger, SkillTier } from './types.js'

**Types in Scope**
- SkillDefinition { id, name, description, trigger, agentTypes, tier, requires?, tools?, prompt } @ types.ts:L19-L38
- SkillTrigger = 'goal_start' | 'goal_continue' | 'review' | 'knowledge_extract' | 'integration' | 'sub_agent' | 'always' @ types.ts:L8-L15
- SkillTier = 'fast' | 'standard' | 'premium' @ types.ts:L17
- LoadOptions { trigger, agentType?, tier?, exclude? } @ loader.ts:L16-L21
- LoadedSkill { skillId, name, prompt, tools, tier, loadedAt } @ skill-loader.ts:L21-L28

**Test Mocks**
- vi.mock('fs', async () => ({ ...await vi.importActual('fs'), existsSync: vi.fn(), readFileSync: vi.fn(), readdirSync: vi.fn() }))
- vi.mock('os', () => ({ default: { homedir: vi.fn().mockReturnValue('/tmp/test-home') } }))
- const MOCK_SKILL_MD = '---\nname: test-skill\nversion: 1\ndescription: Test\nagentTypes: [executor]\ntier: fast\n---\n## Prompt'

**Danger Zones**
- loader.ts L141: skillLoader 单例 — 被 agent-context.ts:L69, session-manager.ts:L20, review-agent.service.ts:L81 导入，不修改导出
- skill-loader.ts L392: skillLoaderService 单例 — 被 MCP tools.ts:L1032 导入
- skill-loader.ts L211-L218: studioEvent.create skill_used 事件 — 保留，OKR 指标数据源
- types.ts SkillDefinition/SkillTrigger/SkillTier 类型 — 不删除，5+ 消费者
- scheduler-prompt.ts L142: buildSubAgentPrompt 硬编码 'sub-agent-workflow' — 路径变化后验证

### proposal-skill-md-generation

**Functions**
- reviewProposal(proposalId: string, approved: boolean) @ skill-extraction.service.ts:L180
- workflowTypeToTriggerDir(workflowType: string): string @ skill-extraction.service.ts (新建)

**Call Chain**
POST /skills/proposals/:id/approve → reviewProposal(id, true) → update Skill.status → roleConfigService.addCapability() → [新增] write SKILL.md file

**Imports**
- import * as fs from 'fs'
- import * as path from 'path'
- import { SKILLS_DIR } from '../skills/skill-loader.js'

**Types in Scope**
- SkillProposal { id, skillId, status, proposedBy, summary, proposedAt, reviewedAt } @ schema.prisma
- Skill { id, name, description, status, category, metadata, trigger, agentTypes, tier } @ schema.prisma

**Test Mocks**
- vi.mock('@dommaker/studio-prisma', () => ({ prisma: { skill: { findFirst: vi.fn() }, skillProposal: { findFirst: vi.fn(), update: vi.fn() } } }))
- vi.mock('fs', async () => ({ ...await vi.importActual('fs'), mkdirSync: vi.fn(), writeFileSync: vi.fn(), existsSync: vi.fn().mockReturnValue(false) }))

**Danger Zones**
- skill-extraction.service.ts L180-L193: reviewProposal 现有逻辑 — 不修改，只在其后追加
- SKILLS_DIR 路径必须与 skill-md-migration-loader-swap 组同步

## AC Groups

### p5-extract-code-structure

#### 实现指南
1. 新建 extraction.ts，不修改 store.ts（职责分离）。2. 正则提取模式：export function name( → 函数名+参数，export class name → 类名，export interface name → 接口名，export type name → 类型名。3. JSDoc 提取：在声明行前查找 /** ... */ 块。4. 返回类型：从函数签名 `): ReturnType` 中正则提取。5. index.ts 追加导出（不删现有导出）。参考 harness/src/knowledge/store.ts 的文件操作模式。

#### 参考模式
- 参考文件遍历: store.ts readEntriesFromDisk() — readdirSync + filter + 跳过隐藏目录
- 参考类型导出: types.ts KnowledgeEntry interface 定义模式
- 参考 index.ts 导出: harness/src/knowledge/index.ts 现有 re-export 模式

#### ⚠️ 注意事项
- ⚠ 不修改 store.ts — extractCodeStructure 是独立原语，不混入存储层
- ⚠ 正则不处理多行函数签名 — MVP 限制，文档中记录
- ⚠ 跳过 node_modules/.git/dist/build — 硬编码排除列表

### p5-improver-scheduler

#### 实现指南
1. 新建 improver-scheduler.service.ts，参考 evolution-scheduler.ts 的 timer + try/catch + logger 模式。2. extractCodeStructure 可能从 @dommaker/harness 导入（P5a 完成后），或内联简化版（正则提取文件名+export 声明）。3. modelGateway 需确认 studio 中的 LLM 调用接口——如果不存在，用 placeholder 注释标记。4. knowledgeBus.write() 需确认写入 API——参考 knowledge-bus.service.ts。5. CONTEXT.md 格式：简短目录索引（≤2KB），不是完整文档。

#### 参考模式
- 参考调度器模式: evolution-scheduler.ts (setInterval + try/catch + logger)
- 参考知识写入: knowledge-bus.service.ts (search/recordPattern)
- 参考 LLM 调用: 需确认 studio 中 modelGateway 的实际路径

#### ⚠️ 注意事项
- ⚠ modelGateway 接口未确认 — 如果不存在，先创建 placeholder 接口
- ⚠ extractCodeStructure 依赖 P5a 完成 — 可用内联简化版先实现
- ⚠ CONTEXT.md 格式 ≤2KB — 不要写完整 API 文档，只写目录索引
- ⚠ 不修改 evolution-scheduler.ts — 两个调度器独立共存

### skill-md-migration-loader-swap

#### 实现指南
1. 先创建 13 个 SKILL.md 文件（AC1）。2. 提取共享 parseFrontmatter 函数（当前 skill-loader.ts L78-L99 和 loader.ts L37-L57 有重复实现）。3. 重写 package loader 的 loadFromDisk/loadAllFromDisk（AC2）。4. 重写 API skill-loader 的文件加载逻辑（AC3），移除 Prisma fallback。5. 删除 definitions/index.ts（AC4）。6. 统一 SKILLS_DIR + 更新 scheduler-prompt.ts（AC5）。关键决策：SKILLS_DIR 统一为 ~/.studio/skills/（对齐 AS-021 spec），需同步更新 loader.ts:L24、skill-loader.ts:L65、scheduler-prompt.ts:L16、pipeline-utils.ts:L33 四处定义。3 个新 Workflow Skill（req/impl/review）的 prompt 内容参考现有 green-only-tdd.md 和 contract-test-writing.md 的格式。

#### 参考模式
- 参考 frontmatter 解析: loader.ts:L37-L57 parseFrontmatter()
- 参考子目录扫描: pipeline-utils.ts:L181-L192 buildSkillPrompt() readdirSync withFileTypes
- 参考 SKILL.md 格式: ~/.studio/knowledge/skills/green-only-tdd.md (frontmatter + prompt + placeholders)
- 参考 loader 测试: packages/studio-skill/src/__tests__/loader.test.ts

#### ⚠️ 注意事项
- ⚠ 不可删除: SkillDefinition/SkillTrigger/SkillTier 类型 — 消费者: agent-context.ts, skill-loader.ts, session-manager.ts
- ⚠ 不可删除: skillLoader 单例导出 — 消费者: agent-context.ts:L69, session-manager.ts:L20
- ⚠ 不可删除: skillLoaderService 单例导出 — 消费者: MCP tools.ts:L1032
- ⚠ 不可修改: studioEvent.create skill_used 事件 — 下游: OKR metrics
- ⚠ SKILLS_DIR 四处定义必须同步修改: loader.ts:L24, skill-loader.ts:L65, scheduler-prompt.ts:L16, pipeline-utils.ts:L33
- ⚠ 旧目录 ~/.studio/knowledge/skills/*.md 迁移后可删除（或保留做兼容）
- ⚠ .md（无名文件）和 proxy.md 不迁移 — 异常/非标准文件

### proposal-skill-md-generation

#### 实现指南
1. reviewProposal() 的 approved 分支（L180+）目前更新 Skill.status + addCapability。在其后追加文件生成。2. 使用 fs.mkdirSync({recursive: true}) + fs.writeFileSync 创建文件。3. workflowTypeToTriggerDir 是纯函数。4. SKILL.md 内容格式对齐 AC1 创建的文件。关键决策：proposal 生成的 skill status='draft'，文件已存在时不覆盖。

#### 参考模式
- 参考 proposal 审批: skill-extraction.service.ts:L180-L193 reviewProposal approved 分支
- 参考文件写入: pipeline-utils.ts buildSkillPrompt 的 SKILL.md 读取模式

#### ⚠️ 注意事项
- ⚠ 不可修改: reviewProposal 的 status 更新 + addCapability 逻辑
- ⚠ 生成的 SKILL.md status 必须是 'draft'
- ⚠ 文件已存在时必须跳过（fs.existsSync 检查）