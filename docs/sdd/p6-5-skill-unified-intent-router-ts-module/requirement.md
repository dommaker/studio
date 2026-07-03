---
id: "cmqa9dqhe0067ez3dym66hgr0"
workUnitId: "cmqa9dru1006wez3dbuspnlpg"
slug: "p6-5-skill-unified-intent-router-ts-module"
title: "P6.5 Skill 统一：intent-router.ts 意图路由模块"
status: "implemented"
version: 2
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["skill-system", "intent-routing", "P6.5", "studio-skill-package"]
createdAt: "2026-06-12T01:39:30.003Z"
updatedAt: "2026-06-14T20:00:00.000Z"
---

# P6.5 Skill 统一：intent-router.ts 意图路由模块

新增 intent-router.ts 纯函数模块，基于 skill 已有的 name/description 做关键词匹配，将任务描述映射到相关 Skill。

**设计决策（v2）**：SKILL.md 是纯内容（prompt 模板），不承担触发/激活声明。intent 匹配基于 skill 已有元数据（name + description），不在 frontmatter 中添加额外字段。

<!-- TASK_TIER {"tier":"fast","reason":"单包内 1 个新文件 + 1 行导出。纯函数模块无跨模块依赖，无 schema 变更，不修改 SKILL.md。"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["SkillDefinition interface @ packages/studio-skill/src/types.ts:L19-L38 — 已有 name + description 字段","SKILLS_DIR @ loader.ts:L23 — ~/.studio/skills 路径已确认存在","package exports @ packages/studio-skill/src/index.ts — 需新增 intent-router 导出","14 个 SKILL.md 文件 @ ~/.studio/skills/ — 已确认存在"],"unverified":[],"newRequired":["intent-router.ts 模块 (packages/studio-skill/src/ 新建)","index.ts 导出 (packages/studio-skill/src/index.ts 新增)"]} -->

### Verified
- ✅ SkillDefinition interface @ packages/studio-skill/src/types.ts:L19-L38 — 已有 name + description 字段
- ✅ SKILLS_DIR @ loader.ts:L23 — ~/.studio/skills 路径已确认存在
- ✅ package exports @ packages/studio-skill/src/index.ts — 需新增 intent-router 导出
- ✅ 14 个 SKILL.md 文件 @ ~/.studio/skills/ — 已确认存在

### 🆕 New Required
- 📝 intent-router.ts 模块 (packages/studio-skill/src/ 新建)
- 📝 index.ts 导出 (packages/studio-skill/src/index.ts 新增)

## AC Groups

### intent-router-module
<!-- MODEL_TIER {"tier":"fast","reason":"单包内改动，纯函数逻辑，无跨模块依赖，无 schema 变更"} -->

#### 验收标准
- [ ] AC1: 新建 packages/studio-skill/src/intent-router.ts，导出 matchIntent(taskText: string, skills: SkillDefinition[]): SkillDefinition[] 纯函数；匹配规则：对每个 skill，检查 taskText 是否包含其 name 或 description 中的关键词（大小写不敏感），返回匹配的 skill 数组（按匹配度降序）；taskText 为空或 skills 为空时返回空数组；不依赖 SkillLoader 实例（调用方传入 skills）
- [ ] AC2: 在 index.ts 添加 export { matchIntent } from './intent-router.js'；不修改现有导出
- [ ] AC3: 新建 packages/studio-skill/src/__tests__/intent-router.test.ts；覆盖：name 匹配返回对应 skill、description 匹配返回对应 skill、无匹配返回空、大小写不敏感、空 taskText 返回空、空 skills 返回空

#### 涉及文件
- packages/studio-skill/src/intent-router.ts（新建）
- packages/studio-skill/src/index.ts
- packages/studio-skill/src/__tests__/intent-router.test.ts（新建）

## 约束
- matchIntent 必须是纯函数（无副作用、无 I/O、不依赖 SkillLoader 实例）
- 不修改 types.ts（不添加 intentKeywords 字段）
- 不修改 loader.ts（不修改 parseFrontmatter）
- 不修改 SKILL.md 文件（SKILL.md 是纯内容，不承担触发声明）
- matchIntent 匹配逻辑大小写不敏感
- 现有 SkillLoader.load() 过滤逻辑不变——intent-router 是额外的排序层

## AC Groups

```json
[
  {
    "id": "intent-router-module",
    "targetRepo": "studio",
    "acs": [
      "AC1: 新建 packages/studio-skill/src/intent-router.ts，导出 matchIntent(taskText: string, skills: SkillDefinition[]): SkillDefinition[] 纯函数；匹配规则：对每个 skill，检查 taskText 是否包含其 name 或 description 中的关键词（大小写不敏感），返回匹配的 skill 数组（按匹配度降序）；taskText 为空或 skills 为空时返回空数组；不依赖 SkillLoader 实例（调用方传入 skills）",
      "AC2: 在 index.ts 添加 export { matchIntent } from './intent-router.js'；不修改现有导出",
      "AC3: 新建 packages/studio-skill/src/__tests__/intent-router.test.ts；覆盖：name 匹配返回对应 skill、description 匹配返回对应 skill、无匹配返回空、大小写不敏感、空 taskText 返回空、空 skills 返回空"
    ],
    "files": [
      "packages/studio-skill/src/intent-router.ts",
      "packages/studio-skill/src/index.ts",
      "packages/studio-skill/src/__tests__/intent-router.test.ts"
    ],
    "dependencies": [],
    "implementationNotes": "步骤：1) 新建 intent-router.ts（matchIntent 纯函数：遍历 skills，对每个 skill 的 name + description 做 case-insensitive 关键词匹配，按匹配度降序返回）。2) index.ts 加导出。3) 新建测试文件。关键决策：匹配 skill 已有元数据，不在 SKILL.md 中添加额外字段。SKILL.md 是纯内容，触发/激活是路由层的问题。",
    "architectureContext": {
      "functions": [
        "SkillDefinition interface @ types.ts:L19-L38 — 已有 id, name, description 等字段",
        "SkillLoader.load(options: LoadOptions): SkillDefinition[] @ loader.ts:L97-L112",
        "SkillLoader.formatForPrompt(skills: SkillDefinition[]): string @ loader.ts:L127-L132",
        "matchIntent(taskText: string, skills: SkillDefinition[]): SkillDefinition[] @ intent-router.ts (新建)"
      ],
      "callChain": "调用方 → skillLoader.load({trigger, agentType, tier}) → matchIntent(taskText, loadedSkills) → 返回匹配的 skill 列表",
      "imports": [
        "import type { SkillDefinition } from './types.js';"
      ],
      "typesInScope": [
        "SkillDefinition { id: string; name: string; description: string; trigger: SkillTrigger; agentTypes: string[]; tier: SkillTier; requires?: string[]; tools?: string[]; prompt: string } @ types.ts:L19-L38"
      ],
      "testMock": [
        "vi.mock('fs', () => ({ default: { existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), readdirSync: vi.fn().mockReturnValue([]) } }));",
        "vi.mock('os', () => ({ default: { homedir: vi.fn().mockReturnValue('/tmp/test-home') } }));"
      ],
      "dangerZones": [
        "types.ts:L19-L38 SkillDefinition — 不修改，不添加新字段",
        "index.ts:L1-L3 现有导出 — 只追加，不修改现有行"
      ],
      "verifiedAt": "2026-06-14 (v2 design revision)"
    },
    "codePatterns": [
      "参考 classifyWorkflow() @ session-summary-generator.ts:L145-L205 — 纯函数关键词匹配模式",
      "参考 loader.test.ts mock 模式 @ __tests__/loader.test.ts:L4-L16 — fs/os mock 模板"
    ],
    "gotchas": [
      "⚠️ matchIntent 返回 SkillDefinition[] 不是 string[] — 调用方需要完整对象",
      "⚠️ 不要在 matchIntent 中调用 skillLoader — 纯函数原则，调用方负责传入 skills",
      "⚠️ 匹配逻辑基于 name/description 子串匹配，不是精确匹配"
    ],
    "modelTier": "fast",
    "modelTierReason": "单包内改动，纯函数逻辑，无跨模块依赖，无 schema 迁移"
  }
]
```

## Files

- packages/studio-skill/src/index.ts
- packages/studio-skill/src/intent-router.ts
- packages/studio-skill/src/__tests__/intent-router.test.ts

## 变更记录

### v2 (2026-06-14)
- 设计决策变更：SKILL.md 是纯内容，不添加 intentKeywords 字段
- intent-router 匹配 skill 已有的 name/description，而非 frontmatter 中的额外字段
- 移除 AC1（types.ts 加字段）、AC2（loader.ts 加字段）、AC5（SKILL.md 加 intentKeywords）
- 移除所有 SKILL.md 文件修改
- 返回值从 string[] 改为 SkillDefinition[]
