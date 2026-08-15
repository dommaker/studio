---
id: "cmqa9dqhe0067ez3dym66hgr0"
goalId: "cmqa9dru1006wez3dbuspnlpg"
slug: "p6-5-skill-unified-intent-router-ts-module"
title: "P6.5 Skill 统一：intent-router.ts 意图路由模块"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["skill-system", "intent-routing", "P6.5", "studio-skill-package"]
createdAt: "2026-06-12T01:39:30.003Z"
updatedAt: "2026-06-12T01:39:31.779Z"
---

# P6.5 Skill 统一：intent-router.ts 意图路由模块

新增 intent-router.ts 纯函数模块，基于关键词匹配将任务描述映射到相关 Skill。两个前置需求（硬编码迁移 + 文件系统读取）已实现。

<!-- TASK_TIER {"tier":"fast","reason":"单包内 3 文件改动（types + loader + 新文件）+ SKILL.md 数据填充。纯函数模块无跨模块依赖，无 schema 变更。"} -->

## Architecture Context

**Functions**
- SkillDefinition interface @ types.ts:L19-L38
- SkillFrontmatter interface @ loader.ts:L25-L34
- parseFrontmatter(content: string): { meta: SkillFrontmatter; body: string } | null @ loader.ts:L36-L56
- frontmatterToSkillDefinition(meta: SkillFrontmatter, prompt: string): SkillDefinition @ loader.ts:L58-L69
- SkillLoader.load(options: LoadOptions): SkillDefinition[] @ loader.ts:L97-L112
- SkillLoader.formatForPrompt(skills: SkillDefinition[]): string @ loader.ts:L127-L132
- matchIntent(taskText: string, skills: SkillDefinition[]): string[] @ intent-router.ts (新建)

**Call Chain**
调用方 → skillLoader.load({trigger, agentType, tier}) → matchIntent(taskText, loadedSkills) → 返回匹配的 skill id 列表

**Imports**
- import type { SkillDefinition } from './types.js';
- import { skillLoader } from './loader.js';

**Types in Scope**
- SkillDefinition { id: string; name: string; description: string; trigger: SkillTrigger; agentTypes: string[]; tier: SkillTier; requires?: string[]; tools?: string[]; prompt: string; intentKeywords?: string[] } @ types.ts:L19-L38
- SkillFrontmatter { name: string; description?: string; trigger?: SkillTrigger; agentTypes?: string[]; tier?: SkillTier; tools?: string[]; status?: string; version?: number; intentKeywords?: string[] } @ loader.ts:L25-L34

**Test Mocks**
- vi.mock('fs', () => ({ default: { existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), readdirSync: vi.fn().mockReturnValue([]) } }));
- vi.mock('os', () => ({ default: { homedir: vi.fn().mockReturnValue('/tmp/test-home') } }));

**Danger Zones**
- loader.ts:L45 parseFrontmatter 正则 (\w+):\s*(.+) — 已支持 camelCase，不要修改
- loader.ts:L48-L49 数组解析逻辑 — 已支持 [a, b] 格式，不要修改
- types.ts:L19-L38 SkillDefinition — 只加 intentKeywords? 字段，不改现有字段
- index.ts:L1-L3 现有导出 — 只追加，不修改现有行

## AC Groups

### intent-router-module

#### 实现指南
步骤：1) types.ts 加 intentKeywords? 字段。2) loader.ts SkillFrontmatter 加字段 + frontmatterToSkillDefinition 映射。3) 新建 intent-router.ts（matchIntent 纯函数：遍历 skills，对每个 skill 的 intentKeywords 做 case-insensitive includes，计数匹配数，按匹配数降序返回 id）。4) index.ts 加导出。5) 14 个 SKILL.md 加 intentKeywords frontmatter。关键决策：matchIntent 是纯函数不依赖 SkillLoader 实例——调用方先 skillLoader.load() 拿到 skills 再传入；评分逻辑用 Map<id, count> 排序，不要引入 LLM。

#### 参考模式
- 参考 classifyWorkflow() @ session-summary-generator.ts:L145-L205 — 纯函数关键词匹配模式
- 参考 parseFrontmatter 数组解析 @ loader.ts:L48-L49 — [a, b] 格式已支持
- 参考 loader.test.ts mock 模式 @ __tests__/loader.test.ts:L4-L16 — fs/os mock 模板

#### ⚠️ 注意事项
- ⚠️ parseFrontmatter 正则 (\w+):\s*(.+) 匹配 intentKeywords — 不需要修改正则
- ⚠️ SKILL.md 数组格式必须是 [a, b, c] 不是 YAML 列表 — parseFrontmatter 只支持方括号格式
- ⚠️ matchIntent 返回 string[] (skill ids) 不是 SkillDefinition[] — 保持轻量
- ⚠️ 不要在 matchIntent 中调用 skillLoader — 纯函数原则，调用方负责传入 skills