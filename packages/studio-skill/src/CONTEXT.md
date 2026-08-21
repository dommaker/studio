# packages/studio-skill/src

### 职责

本目录是 Studio Skill 的核心模块，负责 Skill 的定义类型、从磁盘加载 Skill 定义（支持 frontmatter 解析和缓存）。为 Agent prompt 注入可加载的能力单元。内置 skill 库正本随包分发（`../skills/`，#223 起正本从数据区翻回仓库，`~/.studio/skills/` 降级为实例化副本），`seed.ts` 负责首启播种与 hash 升级。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `SkillDefinition` | `types.ts` | Skill 类型定义，包含 id、name、description、agentTypes、requires、tools、prompt |
| `LoadOptions` | `loader.ts` | `load()` 的参数接口：agentType、exclude |
| `SkillLoader` | `loader.ts` | 技能加载器类，支持缓存（5 分钟 TTL）和懒加载 |
| `skillLoader` | `loader.ts` | `SkillLoader` 的单例实例 |
| `seedBuiltinSkills` | `seed.ts` | 内置 skill 同步：缺→拷贝、未改→覆盖升级、无台账且与正本一致→收养写台账（#225）、用户改过/无台账不一致→不动；best-effort 不 throw |
| `hashSkillDir` | `seed.ts` | skill 目录树内容 hash（sha256，排序相对路径+逐文件内容） |

### 依赖关系

上游：`@dommaker/studio-shared`（frontmatter 解析复用其 `parseFrontmatter`、`studioPath`）、Node 内置模块（`fs`、`path`、`os`、`crypto`、`url`）及同目录 `types.ts`（提供类型 `SkillDefinition`）。

下游：
- `apps/api` 模块：`review-agent.service.ts`、`prompt-builder.ts`、`skill.tools.ts`、`skill-loader.ts`、`index.ts`（启动 seed 钩）
- `packages/studio-agent` 模块：`runner-params.ts`

### 注意事项

- `SkillLoader.load()` 为同步方法，首次调用时扫描 `~/.studio/skills/<skillName>/SKILL.md` 目录，结果缓存 5 分钟后自动刷新。
- 技能目录路径可通过环境变量 `SKILLS_DIR` 覆盖，便于测试隔离。
- Frontmatter 解析统一委托 `@dommaker/studio-shared` 的 `parseFrontmatter`（简易行正则，不依赖 YAML 库），本包仅做 `SkillFrontmatter` 类型适配。
- `SkillLoader` 实例 `skillLoader` 是全局单例，导出时直接实例化，内部 `customSkillsProvided` 标记未在源码完整展现，但用于区分是否已手动注册自定义技能。
- seed 升级台账 = `<SKILLS_DIR>/.builtin-hashes.json`（name→内容 hash 中央文件，skill 目录与仓库逐字节一致）；seed 时机 = API 启动（`apps/api/src/index.ts`，有变更才重生成 MANIFEST）；仓库移除的 skill 本地留置转用户自有，用户删除的内置 skill 下次启动重建。
