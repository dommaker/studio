# apps/api/src/modules/skills

### 职责

skills 模块负责技能（Skill）的完整生命周期管理，包括基于文件的技能元数据存储（SkillStore）、技能目录扫描与加载（manifest-loader）、基于描述的技能匹配（skill-selector）、从 WorkUnit 执行中提取可复用模式（skill-extraction.service）以及对应的 REST API 路由（routes.ts、skill-proposal-routes.ts）。提案审批生命周期（存取/发卡/approve/reject）自 #354 起归 review-proposal 正本，本模块只保留 adapter（review-adapter.ts）。所有数据存储已从 Prisma 迁移至文件系统。

### 词汇表

- **Skill 加载（loaded）**：agent 经 MCP 工具 `loadSkill` 显式拉取 SKILL.md 正文。`knowledge:skill_used` 事件的唯一语义（#60 决策，2026-08-09；#172 落地）：发射点 = `skill-loader.ts` 的 `loadSkill`，payload 携带 `workUnitId`（调用方已知时），envelope level=debug。
- **Skill 曝光（exposed）**：已废除的概念。旧口径把「skill 索引条目进入 prompt」记为 skill_used，实测为常量集合（14/20 skill，零信息量），发射已删除（#60 决策，#172 落地，prompt-composer.ts）。基于曝光口径的降级提案统计无效，修复归知识飞轮 handoff。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| loadManifest, SkillEntry | manifest-loader.ts | 扫描技能目录，读取 SKILL.md frontmatter（name/description/agentTypes/status/triggers/consumers）构建技能条目；status 显式非 published 跳过 |
| generateManifest | manifest-generator.ts | 从 frontmatter 重新生成 SKILLS_DIR/MANIFEST.md（GENERATED 文件，best-effort 不 throw）；skill-store 写 SKILL.md 后自动调用 |
| registerSkillReviewAdapter, getSkillReviewAdapter, submitSkillProposal, SkillReviewProposal | review-adapter.ts | #354：提案审批 adapter（kind='skill'），接线 review-proposal 正本；卡片渲染（extraction/distill 两种旧卡文案）+ onApprove（skill→draft + 生成 SKILL.md）；存取物化 <dataDir>/skill-proposals.jsonl |
| router | routes.ts | 技能 CRUD + discover 路由，挂载至 /api/v1/skills |
| SkillExtractionService 类, ExtractedSkillProposal | skill-extraction.service.ts | 从 WorkUnit 中提取可复用模式并生成提案（saveProposal 经 submitSkillProposal 发卡） |
| router | skill-proposal-routes.ts | 提案列表、扫描、提取、撤回路由，挂载至 /api/v1/skills/proposals；审批端点已删（#354，走 /api/v1/review-proposals/skill/:id/*） |
| selectSkills | skill-selector.ts | 三层策略技能匹配：声明 triggers 时匹配 triggers（替代长 description），否则匹配 description（排除 NOT-for）；consumers 含 loop 的 skill 不参与 |
| selectSkillsWithDomain, parseSkillHintsFromScope | skill-selector.ts | 决策 7/8/11：相关度排序器（显式 +hints > 域匹配（阶段词表归一化）> scope 匹配 > 其余按热度/名称序），全量不封顶（调用方按预算截断）；+skill 从 scope 解析 |
| selectSkillsForInjection | skill-selector.ts | #92（#88）：skills 索引硬预裁剪 —— 只返回 hint（+skill 点名）+ 域匹配两类（按 name 去重、hint 置顶）；scope 文本匹配与 rest 热度不进注入段（段尾 MANIFEST 指针按需兜底）。复用 selectSkillsWithDomain 的 active/hint/域匹配口径（normalizeToStage 归一化） |
| SkillRecord, SkillCreateInput, SkillUpdateInput | skill-store.ts | 技能元数据的类型定义及文件型 CRUD |
| LoadedSkill, SessionSkillState, LoadSkillOptions | skill-loader.ts | 技能加载相关的类型定义 |
| aggregateSkillUsage, scanSkillDemotions, approveDemotion, rejectDemotion, DemotionProposalStore | skill-demotion.ts | §10.6 降级通路：skill_used 事件 + WU 终态聚合 → 降级提案（只提案不自动生效；approve 改 frontmatter status，正文逐字节保留）；提案存 ~/.studio/data/skills/demotion-proposals.json |
| router | skill-demotion-routes.ts | 降级提案列表（?scan=true 触发扫描）/ 审批路由，挂载至 /api/v1/skills/demotion-proposals（先于 /api/v1/skills 注册） |

### 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared`（多个文件：logger、FileStore、modelGateway、recordDecision）
- `@dommaker/studio-skill`（skill-loader.ts 中的 SkillTier 类型）
- `express`（routes.ts、skill-proposal-routes.ts 中的 Router）
- Node.js 内置模块：fs、path、os、crypto
- `../channels/channel-message.service.js`（skill-proposal-routes.ts 的 retract 路由使用）
- `../review-proposal/registry.js`、`../review-proposal/service.js`（review-adapter.ts 接线正本）
- `./skill-store.js`、`./review-adapter.js`（内部跨文件引用）

**下游（谁依赖本目录）**
- `apps/api/src/modules/agents`（auditor-execution.ts、auditor-rules.ts）
- `apps/api/src/modules/events`（session-summary-generator.ts）
- `apps/api/src/modules/knowledge`（pattern-miner.ts）
- `apps/api/src/modules/mcp`（skill.tools.ts）
- `apps/api/src/modules/workunit`（workunit.service.ts）
- `apps/api/src/route-registry.ts`

### 注意事项

- 所有数据存储已从 Prisma 迁移至文件系统（D-005），无数据库依赖
- SKILL.md 文件采用 frontmatter 格式，存放于 `~/.studio/skills/` 目录；技能索引存于 `~/.studio/skills-index.json`；提案存取自 #354 起归 review-proposal 正本，落 `~/.studio/skill-proposals.jsonl`（append-only + 状态墓碑折叠，词表 pending|executed|rejected|failed|card-failed）。旧自持存储 `~/.studio/proposals.json` 随 proposal-store.ts 退役：历史文件不改写不迁移，其中存量 pending 提案不再进入待审列表
- `loadManifest()` 使用内存缓存，变更需重启进程或重新调用清除缓存
- 两个路由文件均导出 `Router` 实例，需分别挂载到 Express 应用的不同路径（/api/v1/skills 与 /api/v1/skills/proposals）
- skill-selector 匹配时会排除 `NOT-for` 子句，避免排除项关键词触发误匹配
- 技能加载器按 SKILL.md frontmatter 的 `tier` 字段记录技能层级（fast/standard/premium）
- 所有日志使用 `@dommaker/studio-shared` 的 logger 实例，统一日志格式
- SkillStore 是模块级单例 + 固定 `~/.studio` 存储路径（无构造注入）——测试须 mock fs 或整个模块（distill-landings / skill-extraction-events 测试同做法）；蒸馏 skill 落地经 `modules/distill/distill-landings.ts` 调 skillStore + submitSkillProposal（#145/#354）。#354 前 skill-extraction 发 skill_review_request 卡直传字面 `system` 作 channelId 的口径问题已随正本接线消除（正本统一解析 #系统 频道取真 id）。
- **鉴权（2026-07-24 收紧）**：skills 8 条写（POST /、PATCH、DELETE、publish、deprecate、restore、usage、retract/decide）+ demotion-proposals approve/reject + proposals 写端点（scan/extract/retract；approve/reject 已于 #354 删除，审批走正本通用端点）已收 requireAuth+requireNotGuest。GET /api/v1/skills/proposals 被 skills 的 GET /:id 遮蔽，属路由顺序 bug（未修）。
- **retract 决策闭环（#278，决策 #250 D2）**：`POST /:id/retract/decide {decision, messageId?}`（routes.ts）补上 retract 下半截——守卫 `status==='under_review'`，confirm→`deprecated`、reject→`published`；messageId 提供时经 `channelMessageService.updateMessageMeta` 回写 retract_confirm 卡 meta.status（非阻断）。注意 retract 端点本体在 proposals 挂载点下，实际路径是 `/api/v1/skills/proposals/:id/retract`（与文件内注释声称的 `/skills/:id/retract` 不符，历史遗留）。
- **手改 SKILL.md 后一次性重生成 MANIFEST.md（#306，2026-08-24）**：在 `apps/api` 目录内用 tsx 跑临时脚本调 `generateManifest()`（manifest-generator.ts:54）——脚本必须放项目目录内，tsx 按脚本位置解析相对导入，放 /tmp 会 MODULE_NOT_FOUND。免手工路径：API 启动时 seed hash 有变更自动重生成。
