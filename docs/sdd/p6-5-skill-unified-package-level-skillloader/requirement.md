---
id: "cmq7v890w001ydj0xhervmpzw"
workUnitId: "cmq7v8ao4002odj0x9c3hfgka"
slug: "p6-5-skill-unified-package-level-skillloader"
title: "P6.5 Skill 统一：package-level SkillLoader 支持磁盘文件读取"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["skill-system", "P6.5", "disk-loading", "unified-architecture"]
createdAt: "2026-06-10T09:27:47.117Z"
updatedAt: "2026-06-10T09:27:49.428Z"
---

# P6.5 Skill 统一：package-level SkillLoader 支持磁盘文件读取

让 packages/studio-skill/src/loader.ts 从 ~/.studio/knowledge/skills/ 读取 SKILL.md 文件，合并优先级：磁盘 > DB > 硬编码

<!-- TASK_TIER {"tier":"standard","reason":"2 个文件改动（loader.ts + 10 SKILL.md），涉及 fs 模块 + merge 逻辑 + frontmatter 解析，需要新测试覆盖磁盘加载路径"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["SKILLS_DIR 路径: API skill-loader.ts:L65 使用 process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'knowledge', 'skills')","frontmatter 格式: 所有 SKILL.md 使用 YAML frontmatter (name/description/trigger/agentTypes/tier/status)","SkillDefinition 类型: packages/studio-skill/src/types.ts:L19-L38 (id/name/description/trigger/agentTypes/tier/requires?/tools?/prompt)","SkillTrigger 类型: types.ts:L8-L15 (goal_start/goal_continue/review/knowledge_extract/integration/sub_agent/always)","消费者 6 处: agent-runner.ts:L599, session-manager.ts:L635, analyst-prompt.ts:L22, review-agent.service.ts:L82/L474, agent-context.ts:L69, skill-loader.ts:L13"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ SKILLS_DIR 路径: API skill-loader.ts:L65 使用 process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'knowledge', 'skills')
- ✅ frontmatter 格式: 所有 SKILL.md 使用 YAML frontmatter (name/description/trigger/agentTypes/tier/status)
- ✅ SkillDefinition 类型: packages/studio-skill/src/types.ts:L19-L38 (id/name/description/trigger/agentTypes/tier/requires?/tools?/prompt)
- ✅ SkillTrigger 类型: types.ts:L8-L15 (goal_start/goal_continue/review/knowledge_extract/integration/sub_agent/always)
- ✅ 消费者 6 处: agent-runner.ts:L599, session-manager.ts:L635, analyst-prompt.ts:L22, review-agent.service.ts:L82/L474, agent-context.ts:L69, skill-loader.ts:L13

## AC Groups

### loader-disk-loading
<!-- MODEL_TIER {"tier":"standard","reason":"涉及 fs 模块 + merge 逻辑 + frontmatter 解析 + 多个消费者，需要新测试覆盖磁盘加载路径和合并优先级"} -->

#### 验收标准
- [ ] AC-1: 在 packages/studio-skill/src/loader.ts 新增私有方法 loadFromDisk(skillName: string): SkillDefinition | null，从 SKILLS_DIR 读取 <skillName>.md 文件，解析 YAML frontmatter（name/description/trigger/agentTypes/tier/status/version），status 非 published 则跳过返回 null，文件不存在返回 null，frontmatter 解析失败返回 null
- [ ] AC-2: 在 packages/studio-skill/src/loader.ts 修改 refreshCache() 方法，合并优先级：① 读取 SKILLS_DIR 下所有 .md 文件（调用 loadAllFromDisk 辅助函数），② 查询 DB published skills（现有逻辑），③ 使用硬编码 allSkillDefinitions 作为 fallback。合并规则：同名 skill 磁盘优先于 DB 优先于硬编码。磁盘目录不存在或为空时退化为现有 DB→硬编码逻辑

#### 涉及文件
- packages/studio-skill/src/loader.ts
- packages/studio-skill/src/__tests__/loader.test.ts

### skill-md-version
<!-- MODEL_TIER {"tier":"fast","reason":"纯文本修改，无代码逻辑，每个文件只加一行"} -->

#### 验收标准
- [ ] AC-3: 为 ~/.studio/knowledge/skills/ 下 10 个与硬编码定义对应的 SKILL.md 文件添加 version: 1 字段到 frontmatter（behaviour-constraints.md, contract-test-writing.md, forensic-review.md, green-only-tdd.md, integration-merge.md, knowledge-extraction.md, multi-stance-review.md, stuck-recovery.md, sub-agent-workflow.md, tool-risk.md）。不修改 proxy.md 和 .md（无名文件）

#### 涉及文件
- ~/.studio/knowledge/skills/behaviour-constraints.md
- ~/.studio/knowledge/skills/contract-test-writing.md
- ~/.studio/knowledge/skills/forensic-review.md
- ~/.studio/knowledge/skills/green-only-tdd.md
- ~/.studio/knowledge/skills/integration-merge.md
- ~/.studio/knowledge/skills/knowledge-extraction.md
- ~/.studio/knowledge/skills/multi-stance-review.md
- ~/.studio/knowledge/skills/stuck-recovery.md
- ~/.studio/knowledge/skills/sub-agent-workflow.md
- ~/.studio/knowledge/skills/tool-risk.md
## 约束
- SkillDefinition 类型不添加 version 字段 — version 是 SKILL.md 文件元数据，不影响运行时类型
- 使用同步 fs 操作 (readFileSync, existsSync, readdirSync) — 保持 load() 方法的同步契约
- SKILLS_DIR 环境变量覆盖 — 与 API-level skill-loader.ts 保持一致
- 不修改消费者代码（agent-runner.ts, session-manager.ts 等） — 接口不变，消费方无感知

## AC Groups

```json
[
  {
    "id": "loader-disk-loading",
    "acs": [
      "AC-1: 在 packages/studio-skill/src/loader.ts 新增私有方法 loadFromDisk(skillName: string): SkillDefinition | null，从 SKILLS_DIR 读取 <skillName>.md 文件，解析 YAML frontmatter（name/description/trigger/agentTypes/tier/status/version），status 非 published 则跳过返回 null，文件不存在返回 null，frontmatter 解析失败返回 null",
      "AC-2: 在 packages/studio-skill/src/loader.ts 修改 refreshCache() 方法，合并优先级：① 读取 SKILLS_DIR 下所有 .md 文件（调用 loadAllFromDisk 辅助函数），② 查询 DB published skills（现有逻辑），③ 使用硬编码 allSkillDefinitions 作为 fallback。合并规则：同名 skill 磁盘优先于 DB 优先于硬编码。磁盘目录不存在或为空时退化为现有 DB→硬编码逻辑"
    ],
    "files": [
      "packages/studio-skill/src/loader.ts",
      "packages/studio-skill/src/__tests__/loader.test.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. 新增 import: fs, path, os (Node.js built-ins)。2. 新增 SKILLS_DIR 常量: process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'knowledge', 'skills') — 与 API skill-loader.ts:L65 保持一致。3. 新增 parseFrontmatter(content: string) 辅助函数 — 参考 API skill-loader.ts:L78-L99 的实现（正则匹配 ---\\n...\\n---，逐行解析 key: value，数组格式 [a, b]）。4. 新增 loadFromDisk(skillName: string): SkillDefinition | null — 读 SKILLS_DIR/<skillName>.md，解析 frontmatter，过滤 status !== 'published'，映射为 SkillDefinition（id=meta.name, trigger 默认 'always', agentTypes 默认 [], tier 默认 'standard'）。5. 新增 loadAllFromDisk(): SkillDefinition[] — readdirSync(SKILLS_DIR) 过滤 .md，逐个 parseFrontmatter，过滤 status !== 'published'，映射为 SkillDefinition[]。6. 修改 refreshCache(): 先调 loadAllFromDisk() 获取 diskSkills，再查 DB，再用 allSkillDefinitions 填充。合并逻辑: new Map<string, SkillDefinition>()，先放硬编码，再用 DB 覆盖同名，再用磁盘覆盖同名（最终磁盘最高优先级）。注意: prisma 为 null 时跳过 DB 查询，磁盘目录不存在时跳过磁盘加载。7. 构造函数不变 — 初始 cache 仍为硬编码，refreshCache 覆盖。",
    "architectureContext": {
      "functions": [
        "loadFromDisk(skillName: string): SkillDefinition | null — 新增私有方法 @ loader.ts",
        "loadAllFromDisk(): SkillDefinition[] — 新增私有方法 @ loader.ts",
        "parseFrontmatter(content: string): { meta: SkillFrontmatter; body: string } | null — 新增私有函数 @ loader.ts",
        "refreshCache(): void — 现有私有方法 L114-L137，修改合并逻辑",
        "maybeRefreshCache(): void — 现有私有方法 L105-L109，不变",
        "load(options: LoadOptions): SkillDefinition[] — 现有公开方法 L48-L63，不变（依赖 cache）",
        "get(id: string): SkillDefinition | undefined — 现有公开方法 L68-L70，不变（依赖 skills Map）"
      ],
      "callChain": "agent-runner.ts:L599 → skillLoader.load() → maybeRefreshCache() → refreshCache() → loadAllFromDisk() + prisma.skill.findMany() + allSkillDefinitions fallback",
      "imports": [
        "import * as fs from 'fs';",
        "import * as path from 'path';",
        "import * as os from 'os';",
        "import type { SkillDefinition, SkillTrigger, SkillTier } from './types.js';",
        "import { allSkillDefinitions } from './definitions/index.js';"
      ],
      "typesInScope": [
        "SkillDefinition { id, name, description, trigger: SkillTrigger, agentTypes: string[], tier: SkillTier, requires?: string[], tools?: string[], prompt: string } @ types.ts:L19-L38",
        "SkillTrigger = 'goal_start' | 'goal_continue' | 'review' | 'knowledge_extract' | 'integration' | 'sub_agent' | 'always' @ types.ts:L8-L15",
        "SkillTier = 'fast' | 'standard' | 'premium' @ types.ts:L17",
        "SkillFrontmatter (新增) { name: string; description?: string; trigger?: SkillTrigger; agentTypes?: string[]; tier?: SkillTier; tools?: string[]; status?: string; version?: number } @ loader.ts",
        "LoadOptions { trigger: SkillTrigger; agentType?: string; tier?: SkillTier; exclude?: string[] } @ loader.ts:L13-L18"
      ],
      "testMock": [
        "vi.mock('fs', () => ({ default: { existsSync: vi.fn(), readFileSync: vi.fn(), readdirSync: vi.fn() } }))",
        "vi.mock('os', () => ({ default: { homedir: vi.fn().mockReturnValue('/tmp/test-home') } }))",
        "构造测试 SKILL.md 内容: '---\\nname: test-skill\\ndescription: test\\ntrigger: always\\nagentTypes: [executor]\\ntier: fast\\nstatus: published\\n---\\n## Prompt\\nContent here'"
      ],
      "dangerZones": [
        "L118 prisma.skill.findMany 返回值 — refreshCache 中 DB 查询结果的 rows.map(r => ...) 必须保留，不能被磁盘逻辑覆盖丢失",
        "L120-L132 DB→cache 映射逻辑 — JSON.parse(r.agentTypes) 和 JSON.parse(r.tools) 有运行时风险（DB 中格式不对会 throw），现有 .catch() 兜底",
        "L24 prisma: any = null — init(prisma) 未调用时 prisma 为 null，refreshCache 直接 return。磁盘加载应在 prisma 为 null 时仍然执行",
        "L106 maybeRefreshCache 中 !this.prisma 直接 return — 即使无 DB 也应允许磁盘刷新"
      ],
      "verifiedAt": "2026-06-10 (当前 HEAD)"
    },
    "codePatterns": [
      "API-level 前置实现参考: apps/api/src/modules/skills/skill-loader.ts:L78-L113 (parseFrontmatter + loadSkillFromDisk + loadAllSkillFiles)",
      "SKILLS_DIR 定义参考: apps/api/src/modules/skills/skill-loader.ts:L65",
      "缓存模式参考: loader.ts:L20 CACHE_TTL_MS + L25-L27 cache/cacheTime/refreshing 状态"
    ],
    "gotchas": [
      "⚠ 不要删除 L118-L132 的 DB→cache 映射逻辑 — 磁盘不可用时 DB 是唯一数据源",
      "⚠ maybeRefreshCache L106 的 !this.prisma return 需要修改 — 允许无 DB 时仍然从磁盘刷新",
      "⚠ .md 文件（无文件名，name 为空）存在于 SKILLS_DIR — loadAllFromDisk 应跳过 name 为空的条目",
      "⚠ proxy.md 存在于 SKILLS_DIR 但不在硬编码列表中 — 磁盘加载会额外加载此 skill，这是预期行为（磁盘可扩展）",
      "⚠ parseFrontmatter 中数组解析 val.startsWith('[') — 需处理引号包裹的数组元素如 [\"a\", \"b\"]"
    ],
    "modelTier": "standard",
    "modelTierReason": "涉及 fs 模块 + merge 逻辑 + frontmatter 解析 + 多个消费者，需要新测试覆盖磁盘加载路径和合并优先级"
  },
  {
    "id": "skill-md-version",
    "acs": [
      "AC-3: 为 ~/.studio/knowledge/skills/ 下 10 个与硬编码定义对应的 SKILL.md 文件添加 version: 1 字段到 frontmatter（behaviour-constraints.md, contract-test-writing.md, forensic-review.md, green-only-tdd.md, integration-merge.md, knowledge-extraction.md, multi-stance-review.md, stuck-recovery.md, sub-agent-workflow.md, tool-risk.md）。不修改 proxy.md 和 .md（无名文件）"
    ],
    "files": [
      "~/.studio/knowledge/skills/behaviour-constraints.md",
      "~/.studio/knowledge/skills/contract-test-writing.md",
      "~/.studio/knowledge/skills/forensic-review.md",
      "~/.studio/knowledge/skills/green-only-tdd.md",
      "~/.studio/knowledge/skills/integration-merge.md",
      "~/.studio/knowledge/skills/knowledge-extraction.md",
      "~/.studio/knowledge/skills/multi-stance-review.md",
      "~/.studio/knowledge/skills/stuck-recovery.md",
      "~/.studio/knowledge/skills/sub-agent-workflow.md",
      "~/.studio/knowledge/skills/tool-risk.md"
    ],
    "dependencies": [],
    "implementationNotes": "每个文件在 frontmatter 块中添加一行 version: 1。插入位置：status 行之后、--- 闭合标记之前。frontmatter 格式示例：---\\nname: green-only-tdd\\n...\\nstatus: published\\nversion: 1\\n---",
    "architectureContext": {
      "functions": [],
      "callChain": "无代码调用链 — 纯文件内容修改",
      "imports": [],
      "typesInScope": [],
      "testMock": [],
      "dangerZones": [
        "⚠ 不要修改 proxy.md — 它不在硬编码列表中，不是本次需求范围",
        "⚠ 不要修改 .md（无名文件）— 它是自动化生成的异常文件，不在需求范围"
      ],
      "verifiedAt": "2026-06-10 (当前 HEAD)"
    },
    "codePatterns": [],
    "gotchas": [
      "⚠ 10 个文件的 name 字段必须与硬编码定义的 id 一致（如 green-only-tdd 对应 greenOnlyTdd），确认 frontmatter name 值正确"
    ],
    "modelTier": "fast",
    "modelTierReason": "纯文本修改，无代码逻辑，每个文件只加一行"
  }
]
```

## Files

- packages/studio-skill/src/__tests__/loader.test.ts
- packages/studio-skill/src/loader.ts
- ~/.studio/knowledge/skills/behaviour-constraints.md
- ~/.studio/knowledge/skills/contract-test-writing.md
- ~/.studio/knowledge/skills/forensic-review.md
- ~/.studio/knowledge/skills/green-only-tdd.md
- ~/.studio/knowledge/skills/integration-merge.md
- ~/.studio/knowledge/skills/knowledge-extraction.md
- ~/.studio/knowledge/skills/multi-stance-review.md
- ~/.studio/knowledge/skills/stuck-recovery.md
- ~/.studio/knowledge/skills/sub-agent-workflow.md
- ~/.studio/knowledge/skills/tool-risk.md