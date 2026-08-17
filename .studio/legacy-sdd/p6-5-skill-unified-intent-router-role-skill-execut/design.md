---
id: "sdd-1782462297850-ogspc8"
goalId: "cmqa9daiy004dez3d7ldp5qbx"
slug: "p6-5-skill-unified-intent-router-role-skill-execut"
title: "P6.5 Skill 统一：intent-router + Role→Skill 绑定接入 executor"
status: "done"
version: 6
designVersion: 6
parentId: "sdd-1782190373471-mx8qas"
changeType: "L3"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["P6.5", "skill-unified", "intent-router", "role-skill-binding", "executor"]
createdAt: "2026-06-12T01:39:06.906Z"
updatedAt: "2026-06-26T08:24:57.850Z"
---

# P6.5 Skill 统一：intent-router + Role→Skill 绑定接入 executor

创建 intent-router 意图路由模块，将 Role→Skill 绑定（boundSkills）接入 scheduler-dispatch executor 流程

<!-- TASK_TIER {"tier":"fast","reason":"用户要求单 acGroup；两个子任务（intent-router 纯函数 + dispatch 接入）互不依赖，可单 session 完成"} -->

## Architecture Context

**Functions**
- parseFrontmatter(content: string): { meta: SkillFrontmatter; body: string } | null @ loader.ts:L77-98
- SkillLoader.load(options: {trigger, agentType, tier, exclude?}): SkillDefinition[] @ loader.ts:L97-112
- SkillLoader.getAll(): SkillDefinition[] @ loader.ts:L114-116（若不存在则用 load({trigger:'always'}))
- dispatchStep(execution, goal, ctx): Promise<void> @ scheduler-dispatch.ts:L67-355
- skillLoaderService.loadSkill(options: LoadSkillOptions): Promise<LoadedSkill | null> @ skill-loader.ts:L204-269
- LoadSkillOptions { sessionId: string; skillName: string; agentType?: string } @ skill-loader.ts:L36-40
- LoadedSkill { skillId: string; name: string; prompt: string; tools: string[]; tier: SkillTier; loadedAt: Date } @ skill-loader.ts

**Call Chain**
dispatchStep() → roleConfigService.getOrCreate('executor') → execConfig.boundSkills → skillLoaderService.loadSkill() × N → 拼接 prompt → agentRunner.execute({prompt})

**Imports**
- import { skillLoaderService } from '../skills/skill-loader.js'; // scheduler-dispatch.ts 新增
- import type { SkillDefinition } from './types.js'; // intent-router.ts
- import type { SkillTrigger } from './types.js'; // loader.ts 已有

**Types in Scope**
- SkillDefinition { id, name, description, trigger, agentTypes, tier, requires?, tools?, prompt, triggers?: { intent?: string[] } } @ types.ts:L19-38（triggers 为新增字段）
- SkillTrigger = 'goal_start' | 'goal_continue' | 'review' | 'knowledge_extract' | 'integration' | 'sub_agent' | 'always' @ types.ts:L8-15
- SkillFrontmatter（loader.ts 内部） { name, description?, trigger?, agentTypes?, tier?, status?, version?, tools?, required?, triggers?: { intent?: string[] } } @ loader.ts:L25-34（triggers 为新增字段）
- RoleConfigData { boundSkills: string[]; boundConstraints: string[]; ... } @ role-config.service.ts:L35-45
- LoadSkillOptions { sessionId: string; skillName: string; agentType?: string } @ skill-loader.ts:L36-40

**Test Mocks**
- vi.mock('../skills/skill-loader.js', () => ({ skillLoaderService: { loadSkill: vi.fn() } })); // 已存在于 role-skill-binding.test.ts
- vi.mock('../roles/role-config.service.js', () => ({ roleConfigService: { getOrCreate: vi.fn() } })); // 已存在

**Danger Zones**
- loader.ts parseFrontmatter L85-94 — 现有正则只匹配单层 key:value，修改时不能破坏已有 14 个 SKILL.md 的解析
- scheduler-dispatch.ts L151-168 — prompt 构建有三条路径（integration/sub-agent/legacy），boundSkills 注入必须在所有路径之后
- scheduler-dispatch.ts L274 — agentRunner.execute() 调用，boundSkills prompt 必须在此之前注入
- skill-loader.ts loadSkill L252 — 写 studioEvent 到 DB，副作用。dispatchStep 中调用时 DB 可能不可用（测试环境需 mock prisma）

## AC Groups

### skill-unified-p65

#### 实现指南
步骤：
1. AC-1a: 修改 types.ts SkillDefinition 接口 — 新增可选字段 triggers?: { intent?: string[] }。
2. AC-1b: 修改 loader.ts parseFrontmatter — 在遍历 yaml 行时，检测 key 是否为 'triggers'，若是则进入子解析模式（收集缩进行作为 intent 数组）。简化方案：检测到 `triggers:` 行后，后续 `  intent: [kw1, kw2]` 行解析为 meta.triggers.intent 数组。实现用 2-pass 或状态机。注意：parseFrontmatter 返回的 meta 需要映射到 SkillDefinition 的 triggers 字段。
3. AC-2: 新建 intent-router.ts — 纯函数，import SkillDefinition from types.ts。matchIntent 遍历 skills，检查 skill.triggers?.intent 数组中是否有 keyword 是 message.toLowerCase() 的子串。
4. AC-3: 新建 intent-router.test.ts — 纯函数直接测试，无需 mock。
5. AC-4: scheduler-dispatch.ts — import { skillLoaderService } from '../skills/skill-loader.js'。在 L96 roleConstraints 赋值后，读取 execConfig.boundSkills。对每个 skillName 调 await skillLoaderService.loadSkill({sessionId: executionId, skillName, agentType: 'executor'})。收集所有 loaded.prompt，拼接为 section。在 L167 buildLegacyPrompt 之后、L274 agentRunner.execute 之前，将 boundSkillSection 追加到 prompt。
6. AC-5: 运行 role-skill-binding.test.ts 验证 3 个用例通过。

关键坑位：
- parseFrontmatter 修改不能破坏现有 14 个 SKILL.md 的解析（它们无 triggers 块）
- skillLoaderService.loadSkill 是 async，dispatchStep 已是 async，无需改签名
- loadSkill 的 sessionId 用于内部 session tracking，用 executionId 即可（每个 dispatch 唯一）
- prompt 拼接位置必须在 buildLegacyPrompt/buildSubAgentPrompt 之后，否则会被覆盖
- SkillFrontmatter（loader.ts 内部接口）也需要新增 triggers 字段以匹配 SkillDefinition

#### 参考模式
- parseFrontmatter 嵌套解析参考：loader.ts L85-94 现有 key:value 解析 + scheduler-prompt.ts L55-64 相同模式
- skillLoaderService.loadSkill 调用参考：skill-loader.ts:204-269 返回 LoadedSkill | null
- prompt section 拼接参考：agent-runner.ts L609-611 roleConstraintSection 拼接模式
- boundSkills 读取参考：scheduler-dispatch.ts L90-100 boundConstraints 读取模式（同一 execConfig 对象）

#### ⚠️ 注意事项
- ⚠️ parseFrontmatter 正则中 \w+ 不匹配连字符——但 SKILL.md 的 key 都是单词（name/trigger/tier），无连字符 key，安全
- ⚠️ skillLoaderService.loadSkill 内部调 prisma.studioEvent.create（L252），测试中 prisma mock 必须覆盖此调用否则报错
- ⚠️ scheduler-dispatch.ts 当前不 import skillLoaderService——需新增 import
- ⚠️ role-skill-binding.test.ts L81-83 mock skillLoaderService 用的是 vi.fn()，不 mock loadSkillFromDisk——测试只验证 loadSkill 被调用，不验证磁盘读取
- ⚠️ 现有 SKILL.md 无 triggers.intent 字段——intent-router 模块创建后暂无数据可匹配，需后续补充 SKILL.md 内容
- ⚠️ definitions/index.ts 是空文件 export {}——不需修改，硬编码已全迁移