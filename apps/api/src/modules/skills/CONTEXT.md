# skills

> 此文件描述 apps/api/src/modules/skills 目录的职责和上下文

## 职责

skills 模块负责技能（Skill）的完整生命周期管理，包括基于文件的技能元数据存储（SkillStore）、提案存储（ProposalStore）、技能目录扫描与加载（manifest-loader）、基于描述的技能匹配（skill-selector）、从 WorkUnit 执行中提取可复用模式（skill-extraction.service）以及对应的 REST API 路由（routes.ts、skill-proposal-routes.ts）。所有数据存储已从 Prisma 迁移至文件系统。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| loadManifest, SkillEntry | manifest-loader.ts | 扫描技能目录，读取 SKILL.md frontmatter 构建技能条目 |
| ProposalStore 类, ProposalRecord, ProposalCreateInput, ProposalUpdateInput, ProposalListFilter | proposal-store.ts | 文件型 CRUD 操作技能提案 |
| router | routes.ts | 技能 CRUD + discover 路由，挂载至 /api/v1/skills |
| SkillExtractionService 类, ExtractedSkillProposal | skill-extraction.service.ts | 从 WorkUnit 中提取可复用模式并生成提案 |
| router | skill-proposal-routes.ts | 提案列表、扫描、提取、审批等路由，挂载至 /api/v1/skills/proposals |
| selectSkills | skill-selector.ts | 基于 description 文本的三层策略技能匹配（排除 NOT-for） |
| SkillRecord, SkillCreateInput, SkillUpdateInput | skill-store.ts | 技能元数据的类型定义及文件型 CRUD |
| LoadedSkill, SessionSkillState, LoadSkillOptions, UnloadSkillOptions | skill-loader.ts | 技能加载相关的类型定义及层级工具权限 |

## 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared`（多个文件：logger、FileStore、modelGateway、recordDecision）
- `@dommaker/studio-skill`（skill-loader.ts 中的 SkillTier 类型）
- `express`（routes.ts、skill-proposal-routes.ts 中的 Router）
- Node.js 内置模块：fs、path、os、crypto
- `../channels/channel-message.service.js`（skill-proposal-routes.ts 使用）
- `./skill-store.js`、`./proposal-store.js`（内部跨文件引用）

**下游（谁依赖本目录）**
- `apps/api/src/modules/agents`（auditor-execution.ts、auditor-rules.ts）
- `apps/api/src/modules/events`（session-summary-generator.ts）
- `apps/api/src/modules/knowledge`（pattern-miner.ts）
- `apps/api/src/modules/mcp`（skill.tools.ts）
- `apps/api/src/modules/workunit`（workunit.service.ts）
- `apps/api/src/route-registry.ts`

## 注意事项

- 所有数据存储已从 Prisma 迁移至文件系统（D-005），无数据库依赖
- SKILL.md 文件采用 frontmatter 格式，存放于 `~/.studio/skills/` 目录；技能索引存于 `~/.studio/skills-index.json`，提案存于 `~/.studio/proposals.json`
- `loadManifest()` 使用内存缓存，变更需重启进程或重新调用清除缓存
- 两个路由文件均导出 `Router` 实例，需分别挂载到 Express 应用的不同路径（/api/v1/skills 与 /api/v1/skills/proposals）
- skill-selector 匹配时会排除 `NOT-for` 子句，避免排除项关键词触发误匹配
- 技能加载器根据 `tier`（fast/standard/premium）控制可访问的工具集合，不同层级工具权限不同
- 所有日志使用 `@dommaker/studio-shared` 的 logger 实例，统一日志格式

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `008912d6`: db-removal): complete Spec 1 AC-2/3/6 — dead table cleanup
- ✅ `b85449b1`: db-removal): final sweep — 全仓库 prisma 引用清零
- ✅ `bdf5fd4a`: test): fix 27 CI test failures across 8 files
- ✅ `32fe0dc3`: merge integration — normalizeTriggerDir + workflowTypeToTriggerDir + vitest aliases
- ✅ `309f6061`: review pipeline — diff scope + discoveredIssues exposure
- ✅ `adb7a9c2`: skill-loader trigger normalization + SKILL.md generation
