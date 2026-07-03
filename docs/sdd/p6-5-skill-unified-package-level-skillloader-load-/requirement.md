---
id: "cmq7vr03n0040dj0x1ken0fzw"
workUnitId: "cmq7vr261004pdj0xef740cyb"
slug: "p6-5-skill-unified-package-level-skillloader-load-"
title: "P6.5 Skill 统一：package-level SkillLoader 磁盘加载 + version 字段"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["p6.5", "skill-unified", "disk-loading", "loader", "frontmatter"]
createdAt: "2026-06-10T09:42:22.012Z"
updatedAt: "2026-06-10T09:42:24.738Z"
---

# P6.5 Skill 统一：package-level SkillLoader 磁盘加载 + version 字段

让 packages/studio-skill/src/loader.ts 从磁盘读取 SKILL.md 文件，合并优先级 disk > DB > hardcoded，并为 10 个 SKILL.md 添加 version 字段

<!-- TASK_TIER {"tier":"fast","reason":"AC-1/AC-2 已实现（未提交），仅剩 AC-3 为 10 个 .md 文件添加 version: 1 行，单文件编辑无跨模块依赖"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["SKILLS_DIR 常量 — loader.ts:L24 使用 process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'knowledge', 'skills')","parseFrontmatter() — loader.ts:L37-L57 解析 YAML frontmatter","frontmatterToSkillDefinition() — loader.ts:L59-L70 转换为 SkillDefinition","loadFromDisk() — loader.ts:L158-L171 按 name 加载单个 .md 文件","loadAllFromDisk() — loader.ts:L177-L190 扫描目录加载所有 published skills","refreshCache() — loader.ts:L205-L257 合并逻辑: disk > DB > hardcoded","SkillFrontmatter.version — loader.ts:L34 已定义 version?: number"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ SKILLS_DIR 常量 — loader.ts:L24 使用 process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'knowledge', 'skills')
- ✅ parseFrontmatter() — loader.ts:L37-L57 解析 YAML frontmatter
- ✅ frontmatterToSkillDefinition() — loader.ts:L59-L70 转换为 SkillDefinition
- ✅ loadFromDisk() — loader.ts:L158-L171 按 name 加载单个 .md 文件
- ✅ loadAllFromDisk() — loader.ts:L177-L190 扫描目录加载所有 published skills
- ✅ refreshCache() — loader.ts:L205-L257 合并逻辑: disk > DB > hardcoded
- ✅ SkillFrontmatter.version — loader.ts:L34 已定义 version?: number

## AC Groups

### disk-loading-and-version
<!-- MODEL_TIER {"tier":"fast","reason":"AC-1/AC-2 已实现，仅 AC-3 为 10 个配置文件添加一行 version: 1"} -->

#### 验收标准
- [ ] AC-1: 在 loader.ts 中新增 loadFromDisk(skillName) 方法解析 frontmatter；loadAllFromDisk() 扫描 SKILLS_DIR 目录加载所有 published .md 文件；frontmatter 无效或 status 非 published 时跳过（⚠ 保留 allSkillDefinitions 硬编码列表——作为 fallback 消费方）
- [ ] AC-2: 修改 refreshCache() 合并优先级为 disk > DB > hardcoded；无 prisma 时仍加载 disk skills；DB 失败时合并 disk + hardcoded（⚠ 保留 CACHE_TTL_MS 5 分钟 TTL 机制——maybeRefreshCache 依赖它）
- [ ] AC-3: 为 10 个硬编码定义对应的 SKILL.md 文件添加 version: 1 字段，插入位置在 status 行之后、--- 闭合标记之前；不修改 proxy.md（非硬编码定义）

#### 涉及文件
- packages/studio-skill/src/loader.ts
- packages/studio-skill/src/__tests__/loader.test.ts
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
- SKILL.md frontmatter 格式: YAML between --- delimiters, 单行 key: value
- parseFrontmatter 不支持多行值、嵌套对象、YAML 数组高级语法——当前格式够用
- SKILLS_DIR 默认 ~/.studio/knowledge/skills/，可通过 SKILLS_DIR 环境变量覆盖
- 合并优先级: disk > DB > hardcoded — 不可逆向
- proxy.md 不在硬编码列表中，磁盘加载后作为额外 skill 引入

## AC Groups

```json
[
  {
    "id": "disk-loading-and-version",
    "acs": [
      "AC-1: 在 loader.ts 中新增 loadFromDisk(skillName) 方法解析 frontmatter；loadAllFromDisk() 扫描 SKILLS_DIR 目录加载所有 published .md 文件；frontmatter 无效或 status 非 published 时跳过（⚠ 保留 allSkillDefinitions 硬编码列表——作为 fallback 消费方）",
      "AC-2: 修改 refreshCache() 合并优先级为 disk > DB > hardcoded；无 prisma 时仍加载 disk skills；DB 失败时合并 disk + hardcoded（⚠ 保留 CACHE_TTL_MS 5 分钟 TTL 机制——maybeRefreshCache 依赖它）",
      "AC-3: 为 10 个硬编码定义对应的 SKILL.md 文件添加 version: 1 字段，插入位置在 status 行之后、--- 闭合标记之前；不修改 proxy.md（非硬编码定义）"
    ],
    "files": [
      "packages/studio-skill/src/loader.ts",
      "packages/studio-skill/src/__tests__/loader.test.ts",
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
    "implementationNotes": "AC-1 和 AC-2 已实现（unstaged changes in loader.ts + loader.test.ts）。AC-3 操作：对 10 个 .md 文件，在 frontmatter 中 status: published 行后插入 version: 1。注意 parseFrontmatter 的正则 (\\w+):\\s*(.+) 能解析数字值，但 meta 存为 string，frontmatterToSkillDefinition 未映射 version 到 SkillDefinition——需要确认是否需要映射（当前 SkillDefinition 类型无 version 字段）。",
    "architectureContext": {
      "functions": [
        "parseFrontmatter(content: string): { meta: SkillFrontmatter; body: string } | null @ L37-L57",
        "frontmatterToSkillDefinition(meta: SkillFrontmatter, prompt: string): SkillDefinition @ L59-L70",
        "loadFromDisk(skillName: string): SkillDefinition | null @ L158-L171",
        "loadAllFromDisk(): SkillDefinition[] @ L177-L190",
        "refreshCache(): void @ L205-L257",
        "maybeRefreshCache(): void @ L195-L199"
      ],
      "callChain": "load() → maybeRefreshCache() → refreshCache() → loadAllFromDisk() → loadFromDisk() → parseFrontmatter() + frontmatterToSkillDefinition()",
      "imports": [
        "import fs from 'fs'",
        "import path from 'path'",
        "import os from 'os'",
        "import type { SkillDefinition, SkillTrigger, SkillTier } from './types.js'",
        "import { allSkillDefinitions } from './definitions/index.js'"
      ],
      "typesInScope": [
        "SkillFrontmatter { name: string; description?: string; trigger?: SkillTrigger; agentTypes?: string[]; tier?: SkillTier; tools?: string[]; status?: string; version?: number } @ loader.ts:L26-L35",
        "SkillDefinition { id: string; name: string; description: string; trigger: SkillTrigger; agentTypes: string[]; tier: SkillTier; tools?: string[]; prompt: string } @ types.ts",
        "LoadOptions { trigger: SkillTrigger; agentType?: string; tier?: SkillTier; exclude?: string[] } @ loader.ts:L16-L21"
      ],
      "testMock": [
        "vi.mock('fs', () => ({ default: { existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), readdirSync: vi.fn().mockReturnValue([]) } }))",
        "vi.mock('os', () => ({ default: { homedir: vi.fn().mockReturnValue('/tmp/test-home') } }))",
        "mockReaddir helper: (fs.readdirSync as unknown as { mockReturnValue: (v: string[]) => void }).mockReturnValue(files)"
      ],
      "dangerZones": [
        "L74 prisma: any — 违反 no_any_type，但不在本次改动范围",
        "L234 rows: any[] — 同上，DB 查询结果类型",
        "parseFrontmatter L46 正则 (\\w+):\\s*(.+) 不处理多行值和嵌套 YAML——当前 SKILL.md 格式简单够用",
        "frontmatterToSkillDefinition 不映射 version 到 SkillDefinition——AC-3 添加 version 字段后需确认是否要映射"
      ],
      "verifiedAt": "5e7c030 (HEAD commit, unstaged changes verified)"
    },
    "codePatterns": [
      "frontmatter 解析参考: apps/api/src/modules/skills/skill-loader.ts:L78-L99（相同实现，已知可复用模式）",
      "SKILLS_DIR 定义参考: apps/api/src/modules/skills/skill-loader.ts:L65（相同 env + fallback）"
    ],
    "gotchas": [
      "⚠️ parseFrontmatter 将所有值存为 string，数字字段 (version, tier) 需要 frontmatterToSkillDefinition 或调用方做类型转换",
      "⚠️ proxy.md 不在硬编码列表中，磁盘加载后会额外引入——预期行为但 agentTypes 为空需确认",
      "⚠️ 无名 .md 文件（name 为空）已被 loadFromDisk L165 跳过——正确行为",
      "⚠️ AC-1/AC-2 代码已写但未提交，需要先 stage 再测试"
    ],
    "modelTier": "fast",
    "modelTierReason": "AC-1/AC-2 已实现，仅 AC-3 为 10 个配置文件添加一行 version: 1"
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