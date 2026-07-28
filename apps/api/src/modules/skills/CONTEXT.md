# skills

> 此文件描述 apps/api/src/modules/skills 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/skills/CONTEXT.md, apps/api/src/modules/skills/routes.ts, apps/api/src/modules/skills/skill-promotion.ts, apps/api/src/modules/skills/skill-demotion.ts, apps/api/src/modules/skills/skill-extraction.service.ts, apps/api/src/modules/skills/skill-loader.ts, apps/api/src/modules/skills/skill-demotion-routes.ts, apps/api/src/modules/skills/skill-proposal-routes.ts, apps/api/src/modules/skills/manifest-generator.ts, apps/api/src/modules/skills/manifest-loader.ts, apps/api/src/modules/skills/skill-selector.ts, apps/api/src/modules/skills/skill-store.ts

## 职责

skills 模块负责技能（Skill）的完整生命周期管理，包括基于文件的技能元数据存储（SkillStore）、提案存储（ProposalStore）、技能目录扫描与加载（manifest-loader）、基于描述的技能匹配（skill-selector）、从 WorkUnit 执行中提取可复用模式（skill-extraction.service）以及对应的 REST API 路由（routes.ts、skill-proposal-routes.ts）。所有数据存储已从 Prisma 迁移至文件系统。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| loadManifest, SkillEntry | manifest-loader.ts | 扫描技能目录，读取 SKILL.md frontmatter（name/description/agentTypes/status/triggers/consumers）构建技能条目；status 显式非 published 跳过 |
| loadSkillContent, loadSkillBody | manifest-loader.ts | 读取 SKILL.md 全文 / 仅正文（剥 frontmatter，agentStep prompt 注入用） |
| generateManifest | manifest-generator.ts | 从 frontmatter 重新生成 SKILLS_DIR/MANIFEST.md（GENERATED 文件，best-effort 不 throw）；skill-store 写 SKILL.md 后自动调用 |
| ProposalStore 类, ProposalRecord, ProposalCreateInput, ProposalUpdateInput, ProposalListFilter | proposal-store.ts | 文件型 CRUD 操作技能提案 |
| router | routes.ts | 技能 CRUD + discover 路由，挂载至 /api/v1/skills |
| SkillExtractionService 类, ExtractedSkillProposal | skill-extraction.service.ts | 从 WorkUnit 中提取可复用模式并生成提案 |
| router | skill-proposal-routes.ts | 提案列表、扫描、提取、审批等路由，挂载至 /api/v1/skills/proposals |
| selectSkills | skill-selector.ts | 三层策略技能匹配：声明 triggers 时匹配 triggers（替代长 description），否则匹配 description（排除 NOT-for）；consumers 含 loop 的 skill 不参与 |
| selectSkillsWithDomain, parseAcceptedTypesFromDescription | skill-selector.ts | §10 域匹配（角色 acceptedTypes ∪ WU type）∩ skill.agentTypes 为主、scope 匹配为次，去重封顶 3 |
| SkillRecord, SkillCreateInput, SkillUpdateInput | skill-store.ts | 技能元数据的类型定义及文件型 CRUD |
| LoadedSkill, SessionSkillState, LoadSkillOptions, UnloadSkillOptions | skill-loader.ts | 技能加载相关的类型定义及层级工具权限 |
| aggregateSkillUsage, scanSkillDemotions, approveDemotion, rejectDemotion, DemotionProposalStore | skill-demotion.ts | §10.6 降级通路：skill_used 事件 + WU 终态聚合 → 降级提案（只提案不自动生效；approve 改 frontmatter status，正文逐字节保留）；提案存 ~/.studio/data/skills/demotion-proposals.json |
| router | skill-demotion-routes.ts | 降级提案列表（?scan=true 触发扫描）/ 审批路由，挂载至 /api/v1/skills/demotion-proposals（先于 /api/v1/skills 注册） |
| validateSkillForPromotion, promoteSkill, extractReferencedPaths | skill-promotion.ts | D11 promote 门禁：① SKILL.md 存在 ② frontmatter name+description+triggers ③ 引用路径（~/ 与绝对路径，glob 退化父目录）真实存在；通过后 frontmatter status=published（正文逐字节保留）+ manifest 缓存失效 + 索引同名 draft/testing 同步。接入 routes POST /:id/publish（拒绝 → 400 + reasons） |

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
- **运行时唯一 skill 源 = `~/.studio/skills/`（SKILLS_DIR 可覆盖）**：apps/api 全部组件、studio-agent worktree-resolver（readSkillIndex/copySkillFiles）、studio-skill loader 都读它。仓库内 `.studio/skills/` 不被任何运行时代码读取——它是 API/测试服务器启动时从 `~/.studio/skills` 批量镜像进来的副本（改动会直接出现在 git 工作区，属同步产物，不要当作代码改动提交）；worktree 里的 `.studio/skills/` 则是 copySkillFiles 从 ~/.studio/skills 复制的产物
- promote 路径 = POST /:id/publish（D11 起挂 skill-promotion 门禁）：匹配池只认磁盘 frontmatter（status 缺省/published），门禁通过才翻 published，未过门禁的 draft 永不进匹配池
- `loadManifest()` 使用内存缓存，变更需重启进程或调用 invalidateManifestCache（promoteSkill 已自动调用）
- 两个路由文件均导出 `Router` 实例，需分别挂载到 Express 应用的不同路径（/api/v1/skills 与 /api/v1/skills/proposals）
- skill-selector 匹配时会排除 `NOT-for` 子句，避免排除项关键词触发误匹配
- 技能加载器根据 `tier`（fast/standard/premium）控制可访问的工具集合，不同层级工具权限不同
- 所有日志使用 `@dommaker/studio-shared` 的 logger 实例，统一日志格式
- **鉴权（2026-07-24 收紧）**：skills 7 条写（POST /、PATCH、DELETE、publish、deprecate、restore、usage）+ demotion-proposals approve/reject + proposals 5 条写已收 requireAuth+requireNotGuest。GET /api/v1/skills/proposals 被 skills 的 GET /:id 遮蔽，属路由顺序 bug（未修）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `6f263685`: p0): 信任链六项修复 — 失败误判/超时机制/reviewReport回传/告警出口/日志隔离/traceId
- ✅ `782ac0a9`: 路由层防御纵深 — 写操作端点加 requireAuth+requireNotGuest/requireAdmin
- ✅ 2026-07-27: B5 顺手修 — claim-skill-persist 2 用例修复：B3a claim 写 timeoutAt 后首次 upsertSnapshot 不再是 matchedSkills 那次（生产行为验证无回归），测试改为按 metadata 内容定位目标调用
- ✅ 2026-07-27: D11 promote 门禁 — 新增 skill-promotion.ts（SKILL.md 存在/frontmatter 三要素/引用路径三校验），接入 POST /:id/publish（拒绝 400+reasons；通过翻磁盘 frontmatter published + 索引同步 + manifest 缓存失效），11 条单测
- ✅ 2026-07-27: P0 修复 5 — skill-loader/skill-extraction/skill-demotion 的 studio-events.jsonl 走 utils/studio-log-path 测试隔离（生产行为不变）
- ✅ 2026-07-24: 写端点收 requireAuth+requireNotGuest
- ✅ `008912d6`: db-removal): complete Spec 1 AC-2/3/6 — dead table cleanup
- ✅ `b85449b1`: db-removal): final sweep — 全仓库 prisma 引用清零
- ✅ `bdf5fd4a`: test): fix 27 CI test failures across 8 files
- ✅ `32fe0dc3`: merge integration — normalizeTriggerDir + workflowTypeToTriggerDir + vitest aliases
- ✅ `309f6061`: review pipeline — diff scope + discoveredIssues exposure
- ✅ `adb7a9c2`: skill-loader trigger normalization + SKILL.md generation
