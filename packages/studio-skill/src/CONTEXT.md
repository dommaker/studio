# src

> 此文件描述 packages/studio-skill/src 目录的职责和上下文

## 职责

本目录是 Studio Skill 的核心模块，负责 Skill 的定义类型、从磁盘加载 Skill 定义（支持 frontmatter 解析和缓存）、以及基于文本匹配的意图路由。为 Agent prompt 注入可加载的能力单元。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `SkillDefinition` | `types.ts` | Skill 类型定义，包含 id、name、description、agentTypes、requires、tools、prompt |
| `LoadOptions` | `loader.ts` | `load()` 的参数接口：agentType、exclude |
| `SkillLoader` | `loader.ts` | 技能加载器类，支持缓存（5 分钟 TTL）和懒加载 |
| `skillLoader` | `loader.ts` | `SkillLoader` 的单例实例 |
| `matchIntent` | `intent-router.ts` | 根据任务文本与 skill name/description 匹配，返回按匹配数降序排列的 skill id 数组 |

## 依赖关系

上游：仅依赖 Node 内置模块（`fs`、`path`、`os`）及同目录 `types.ts`（提供类型 `SkillDefinition`）。

下游：
- `apps/api` 模块：`review-agent.service.ts`、`prompt-builder.ts`、`skill.tools.ts`、`skill-loader.ts`
- `packages/studio-agent` 模块：`runner-params.ts`

## 注意事项

- `SkillLoader.load()` 为同步方法，首次调用时扫描 `~/.studio/skills/<skillName>/SKILL.md` 目录，结果缓存 5 分钟后自动刷新。
- 技能目录路径可通过环境变量 `SKILLS_DIR` 覆盖，便于测试隔离。
- Frontmatter 解析使用简易行正则，不依赖 YAML 库（`definition/index.ts` 为空文件，仅用作占位）。
- `matchIntent` 使用简单的关键词包含计数算法，不涉及 NLP 或语义匹配。
- `SkillLoader` 实例 `skillLoader` 是全局单例，导出时直接实例化，内部 `customSkillsProvided` 标记未在源码完整展现，但用于区分是否已手动注册自定义技能。
