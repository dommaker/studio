# skills

> 此文件描述 apps/api/src/modules/skills 目录的职责和上下文

## 职责

skills 模块负责技能（Skill）的完整生命周期管理，包括基于文件的技能元数据存储（SkillStore）、提案存储（ProposalStore）、技能目录扫描与加载（manifest-loader）、基于描述的技能匹配（skill-selector）、从 WorkUnit 执行中提取可复用模式（skill-extraction.service）以及对应的 REST API 路由（routes.ts、skill-proposal-routes.ts）。所有数据存储已从 Prisma 迁移至文件系统。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| loadManifest, SkillEntry | manifest-loader.ts | 扫描技能目录，读取 SKILL.md frontmatter（name/description/agentTypes/status/triggers/consumers）构建技能条目；status 显式非 published 跳过 |
| generateManifest | manifest-generator.ts | 从 frontmatter 重新生成 SKILLS_DIR/MANIFEST.md（GENERATED 文件，best-effort 不 throw）；skill-store 写 SKILL.md 后自动调用 |
| ProposalStore 类, ProposalRecord, ProposalCreateInput, ProposalUpdateInput, ProposalListFilter | proposal-store.ts | 文件型 CRUD 操作技能提案 |
| router | routes.ts | 技能 CRUD + discover 路由，挂载至 /api/v1/skills |
| SkillExtractionService 类, ExtractedSkillProposal | skill-extraction.service.ts | 从 WorkUnit 中提取可复用模式并生成提案 |
| router | skill-proposal-routes.ts | 提案列表、扫描、提取、审批等路由，挂载至 /api/v1/skills/proposals |
| selectSkills | skill-selector.ts | 三层策略技能匹配：声明 triggers 时匹配 triggers（替代长 description），否则匹配 description（排除 NOT-for）；consumers 含 loop 的 skill 不参与 |
| selectSkillsWithDomain, parseSkillHintsFromScope | skill-selector.ts | 决策 7/8/11：相关度排序器（显式 +hints > 域匹配（阶段词表归一化）> scope 匹配 > 其余按热度/名称序），全量不封顶（调用方按预算截断）；+skill 从 scope 解析 |
| SkillRecord, SkillCreateInput, SkillUpdateInput | skill-store.ts | 技能元数据的类型定义及文件型 CRUD |
| LoadedSkill, SessionSkillState, LoadSkillOptions | skill-loader.ts | 技能加载相关的类型定义 |
| aggregateSkillUsage, scanSkillDemotions, approveDemotion, rejectDemotion, DemotionProposalStore | skill-demotion.ts | §10.6 降级通路：skill_used 事件 + WU 终态聚合 → 降级提案（只提案不自动生效；approve 改 frontmatter status，正文逐字节保留）；提案存 ~/.studio/data/skills/demotion-proposals.json |
| router | skill-demotion-routes.ts | 降级提案列表（?scan=true 触发扫描）/ 审批路由，挂载至 /api/v1/skills/demotion-proposals（先于 /api/v1/skills 注册） |

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
- 技能加载器按 SKILL.md frontmatter 的 `tier` 字段记录技能层级（fast/standard/premium）
- 所有日志使用 `@dommaker/studio-shared` 的 logger 实例，统一日志格式
- **鉴权（2026-07-24 收紧）**：skills 7 条写（POST /、PATCH、DELETE、publish、deprecate、restore、usage）+ demotion-proposals approve/reject + proposals 5 条写已收 requireAuth+requireNotGuest。GET /api/v1/skills/proposals 被 skills 的 GET /:id 遮蔽，属路由顺序 bug（未修）。
