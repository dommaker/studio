---
id: "cmqa9d8nz003gez3dvdjzcnqr"
workUnitId: "cmqa9daiy004dez3d7ldp5qbx"
slug: "p6-5-skill-unified-intent-router-role-skill-execut"
title: "P6.5 Skill 统一：Role→Skill 绑定接入 executor"
status: "done"
version: 2
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["P6.5", "skill-unified", "role-skill-binding", "executor"]
createdAt: "2026-06-12T01:39:06.906Z"
updatedAt: "2026-06-14T20:00:00.000Z"
---

# P6.5 Skill 统一：Role→Skill 绑定接入 executor

将 Role→Skill 绑定（boundSkills）接入 scheduler-dispatch executor 流程。

**设计决策（v2）**：intent-router 模块已拆分到独立 SDD（p6-5-skill-unified-intent-router-ts-module）。本 SDD 只负责 boundSkills 注入 executor prompt 的逻辑。SKILL.md 不添加 triggers.intent 字段——intent 匹配基于 skill 已有的 name/description。

<!-- TASK_TIER {"tier":"standard","reason":"跨 2 个包（studio-skill + api），修改现有 dispatch 流程"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["RoleConfigData.boundSkills: string[] — role-config.service.ts:39，Prisma schema:895","skillLoaderService.loadSkill({sessionId, skillName, agentType}) — skill-loader.ts:204","roleConfigService.getOrCreate('executor', companyId) — role-config.service.ts","SkillLoader.load({trigger, agentType, tier, exclude?}) — packages/studio-skill/src/loader.ts","dispatchStep(execution, goal, ctx) — scheduler-dispatch.ts:67"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ RoleConfigData.boundSkills: string[] — role-config.service.ts:39，Prisma schema:895
- ✅ skillLoaderService.loadSkill({sessionId, skillName, agentType}) — skill-loader.ts:204
- ✅ roleConfigService.getOrCreate('executor', companyId) — role-config.service.ts
- ✅ SkillLoader.load({trigger, agentType, tier, exclude?}) — packages/studio-skill/src/loader.ts
- ✅ dispatchStep(execution, goal, ctx) — scheduler-dispatch.ts:67

### 🆕 New Required
- 无 schema 变更

## AC Groups

### role-skill-binding
<!-- MODEL_TIER {"tier":"standard","reason":"跨 2 个包（studio-skill + api），修改现有 dispatch 流程"} -->

#### 验收标准
- [x] AC-1: 在 apps/api/src/modules/goals/scheduler-dispatch.ts；读取 roleConfig.boundSkills 数组；对每个 skillName 调用 skillLoaderService.loadSkill({sessionId: executionId, skillName, agentType: 'executor'})；将所有成功加载的 skill 的 prompt 追加到 prompt（`## Bound Skills` header + skill prompts）；loadSkill 返回 null 时静默跳过；不修改 agentRunner.execute() 调用签名
- [x] AC-2: apps/api/src/modules/goals/__tests__/role-skill-binding.test.ts 已有 3 个测试用例（boundSkills 含 skill 时 prompt 包含内容、空 boundSkills 无注入、不存在的 skill 静默跳过）；实现 AC-1 后这 3 个测试全部通过；未修改测试文件

#### 涉及文件
- apps/api/src/modules/goals/scheduler-dispatch.ts
- apps/api/src/modules/goals/__tests__/role-skill-binding.test.ts（不修改，验证通过）

## 约束
- 不修改 agentRunner.execute() 调用签名
- 不修改 SKILL.md 文件
- 不修改 types.ts（不添加 triggers 字段）
- 不修改 loader.ts（不修改 parseFrontmatter）
- 不修改 role-skill-binding.test.ts（AC-2 只验证通过）
- skillLoaderService.loadSkill 是 async，dispatchStep 已是 async，无需改签名

## AC Groups

```json
[
  {
    "id": "role-skill-binding",
    "targetRepo": "studio",
    "acs": [
      "AC-1: ✅ 在 apps/api/src/modules/goals/scheduler-dispatch.ts；读取 roleConfig.boundSkills 数组；对每个 skillName 调用 skillLoaderService.loadSkill({sessionId: executionId, skillName, agentType: 'executor'})；将所有成功加载的 skill 的 prompt 追加到 prompt（## Bound Skills header + skill prompts）；loadSkill 返回 null 时静默跳过；不修改 agentRunner.execute() 调用签名",
      "AC-2: ✅ apps/api/src/modules/goals/__tests__/role-skill-binding.test.ts 3 个测试用例全部通过（boundSkills 含 skill 时 prompt 包含内容、空 boundSkills 无注入、不存在的 skill 静默跳过）；未修改测试文件"
    ],
    "files": [
      "apps/api/src/modules/goals/scheduler-dispatch.ts",
      "apps/api/src/modules/goals/__tests__/role-skill-binding.test.ts（不修改，验证通过）"
    ],
    "dependencies": [],
    "implementationNotes": "步骤：\n1. AC-1: scheduler-dispatch.ts — import { skillLoaderService } from '../skills/skill-loader.js'。在 execConfig 读取后，读取 execConfig.boundSkills。对每个 skillName 调 await skillLoaderService.loadSkill({sessionId: executionId, skillName, agentType: 'executor'})。收集所有 loaded 的 name + description，拼接为 '## Available Skills\\n- {name}: {description}' section。在 prompt 构建完成后、agentRunner.execute 之前，将 skillIndexSection 追加到 prompt。\n2. AC-2: 运行 role-skill-binding.test.ts 验证 3 个用例通过。\n\n设计决策：\n- 只注入元数据（name + description），不注入完整 prompt\n- executor 是 Claude Code CLI 子进程，可通过 MCP loadSkill 按需获取完整内容\n- Studio MCP 已注册 loadSkill tool，.claude/settings.json 自动配置\n\n关键坑位：\n- prompt 拼接位置必须在 buildLegacyPrompt/buildSubAgentPrompt 之后，否则会被覆盖\n- loadSkill 的 sessionId 用于内部 session tracking，用 executionId 即可（每个 dispatch 唯一）\n- skillLoaderService.loadSkill 内部调 prisma.studioEvent.create，测试中 prisma mock 必须覆盖此调用",
    "architectureContext": {
      "functions": [
        "dispatchStep(execution, goal, ctx): Promise<void> @ scheduler-dispatch.ts:L67-355",
        "skillLoaderService.loadSkill(options: LoadSkillOptions): Promise<LoadedSkill | null> @ skill-loader.ts:L204-269",
        "LoadSkillOptions { sessionId: string; skillName: string; agentType?: string } @ skill-loader.ts:L36-40",
        "LoadedSkill { skillId: string; name: string; prompt: string; tools: string[]; tier: SkillTier; loadedAt: Date } @ skill-loader.ts"
      ],
      "callChain": "dispatchStep() → roleConfigService.getOrCreate('executor') → execConfig.boundSkills → skillLoaderService.loadSkill() × N → 拼接 prompt → agentRunner.execute({prompt})",
      "imports": [
        "import { skillLoaderService } from '../skills/skill-loader.js'; // scheduler-dispatch.ts 新增"
      ],
      "typesInScope": [
        "RoleConfigData { boundSkills: string[]; boundConstraints: string[]; ... } @ role-config.service.ts:L35-45",
        "LoadSkillOptions { sessionId: string; skillName: string; agentType?: string } @ skill-loader.ts:L36-40"
      ],
      "testMock": [
        "vi.mock('../skills/skill-loader.js', () => ({ skillLoaderService: { loadSkill: vi.fn() } })); // 已存在于 role-skill-binding.test.ts",
        "vi.mock('../roles/role-config.service.js', () => ({ roleConfigService: { getOrCreate: vi.fn() } })); // 已存在"
      ],
      "dangerZones": [
        "scheduler-dispatch.ts L151-168 — prompt 构建有三条路径（integration/sub-agent/legacy），boundSkills 注入必须在所有路径之后",
        "scheduler-dispatch.ts L274 — agentRunner.execute() 调用，boundSkills prompt 必须在此之前注入",
        "skill-loader.ts loadSkill L252 — 写 studioEvent 到 DB，副作用。dispatchStep 中调用时 DB 可能不可用（测试环境需 mock prisma）"
      ],
      "verifiedAt": "2026-06-14（v2 design revision）"
    },
    "codePatterns": [
      "skillLoaderService.loadSkill 调用参考：skill-loader.ts:204-269 返回 LoadedSkill | null",
      "prompt section 拼接参考：agent-runner.ts L609-611 roleConstraintSection 拼接模式",
      "boundSkills 读取参考：scheduler-dispatch.ts L90-100 boundConstraints 读取模式（同一 execConfig 对象）"
    ],
    "gotchas": [
      "⚠️ 只注入 name + description 到 prompt，不注入完整 skill prompt——executor 通过 MCP loadSkill 按需获取",
      "⚠️ skillLoaderService.loadSkill 内部调 prisma.studioEvent.create（L252），测试中 prisma mock 必须覆盖此调用否则报错",
      "⚠️ scheduler-dispatch.ts 当前不 import skillLoaderService——需新增 import",
      "⚠️ role-skill-binding.test.ts L81-83 mock skillLoaderService 用的是 vi.fn()，不 mock loadSkillFromDisk——测试只验证 loadSkill 被调用，不验证磁盘读取",
      "⚠️ definitions/index.ts 是空文件 export {}——不需修改，硬编码已全迁移"
    ],
    "modelTier": "standard",
    "modelTierReason": "跨 2 个包（studio-skill + api），修改现有 dispatch 流程"
  }
]
```

## Files

- apps/api/src/modules/goals/__tests__/role-skill-binding.test.ts（不修改，验证通过）
- apps/api/src/modules/goals/scheduler-dispatch.ts

## 变更记录

### v2 (2026-06-14)
- 设计决策变更：SKILL.md 是纯内容，不添加 triggers.intent 字段
- intent-router 模块拆分到独立 SDD（p6-5-skill-unified-intent-router-ts-module）
- 移除 AC-1（types.ts 加 triggers 字段）、AC-2（intent-router 创建）、AC-3（intent-router 测试）
- 保留 AC-4（boundSkills 注入）→ 重编号为 AC-1，保留 AC-5（测试验证）→ 重编号为 AC-2
- 移除所有 types.ts、loader.ts、SKILL.md 修改
- AC-1 改为元数据索引模式：只注入 name + description 到 prompt，executor 通过 MCP loadSkill 按需获取完整内容
