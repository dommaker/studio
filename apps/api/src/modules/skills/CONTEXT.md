# apps/api/src/modules/skills

### 职责

skills 模块负责技能（Skill）的完整生命周期管理，包括基于文件的技能元数据存储（SkillStore）、技能目录扫描与加载（manifest-loader）、基于描述的技能匹配（skill-selector）、从 WorkUnit 执行中提取可复用模式（skill-extraction.service）以及对应的 REST API 路由（routes.ts）。提案审批生命周期（存取/发卡/approve/reject）自 #354 起归 review-proposal 正本，本模块只保留 adapter（review-adapter.ts）。所有数据存储已从 Prisma 迁移至文件系统。

**HTTP 端点面（P4.3，2026-10-17）**：/api/v1/skills 面只剩 3 条有消费方的端点——GET /（scripts/perf/bench.ts perf 基线脚本）、GET /manifest（前端 RoleSkillsModal skill 多选数据源）、POST /:id/retract/decide（前端 useChannelCardActions）。其余 16 条孤儿端点随批删除（纯死代码面，不改运行时行为）：routes.ts 10 条（/discover、/stats、GET /:id、POST /、PATCH /:id、DELETE /:id、/:id/publish、/:id/deprecate、/:id/restore、/:id/usage）+ 原 skill-proposal-routes.ts 4 条（proposals 列表/scan/extract/retract，整文件删除）+ 原 skill-demotion-routes.ts 3 条（demotion-proposals 列表/approve/reject，整文件删除）。被删端点背后的 service 入口全部保留：skill 创建走 distill → submitSkillProposal 直调（distill-landings.ts），usage 事件由 mcp/skill.tools.ts 与 skill-loader 直写，promoteSkill / SkillExtractionService / skill-demotion 聚合扫描（scanSkillDemotions 由 bootstrap/bridges.ts 直调）均无 HTTP 消费方后保留在 service 层；demotion 端点上 `?scan=true` 手动触发器随端点消失属预期（扫描入口在 bootstrap 侧）。防遮蔽回归测试 skill-stats-route.test.ts 与 demotion 路由测试随端点删除。

### 词汇表

- **Skill 使用（used）**：agent 在 WU 执行期间获取 SKILL.md 全文，渠道无关（loadSkill / Read / cat 均算）。`knowledge:skill_used` 事件（#60 决策，2026-08-09；#172 落地）发射点三处：`skill-loader.ts`（loadSkill 文件路径）、`mcp/skill-tools.ts`（loadSkill cache 路径，度量地基票 A 补）、`skill-usage-scan.ts`（WU done transcript 后验扫描，主口径——agent 直读文件绕开 loadSkill 时仍能在 rawOutput 路径痕迹中测到）。payload 携带 `workUnitId`（已知时）+ `channel`；envelope level=info（度量地基票 C 提为 signal：热 30 天 → 月度 gz 归档，不再随噪声 7 天滚）。
- **Skill 曝光（exposed）**：曝光事件发射已废除（旧口径把「skill 索引条目进入 prompt」记为 skill_used，实测为常量集合零信息量，#60 决策，#172 落地）。度量地基票 D 起曝光以 `exposures` 统计字段恢复（matchedSkills 命中计数），仅降级提案人审参考，不参与判定；successRate 归因同步从曝光改为使用（有 skill_used 的 WU 才背成败）。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| index.ts | 模块公共出口（barrel） | P2-c 立界：跨模块唯一合法 import 面（实际消费反推生成）；深路径 import 由 eslint `local/no-deep-module-import` 拦截 |
| loadManifest, SkillEntry | manifest-loader.ts | 扫描技能目录，读取 SKILL.md frontmatter（name/description/agentTypes/status/triggers/consumers）构建技能条目；status 显式非 published 跳过 |
| generateManifest | manifest-generator.ts | 从 frontmatter 重新生成 SKILLS_DIR/MANIFEST.md（GENERATED 文件，best-effort 不 throw）；skill-store 写 SKILL.md 后自动调用 |
| registerSkillReviewAdapter, getSkillReviewAdapter, submitSkillProposal, repostSkillProposal, SkillReviewProposal | review-adapter.ts | #354：提案审批 adapter（kind='skill'），接线 review-proposal 正本；卡片渲染 + onApprove；#716 起 repost 认养 pending 或重发 card-failed，供蒸馏恢复按原 proposal 续跑 |
| router | routes.ts | P4.3 后剩 3 条端点：GET /（列表分页）、GET /manifest（#462 角色编辑 skill 多选数据源）、POST /:id/retract/decide（#278 撤回裁决），挂载至 /api/v1/skills |
| SkillExtractionService 类, ExtractedSkillProposal | skill-extraction.service.ts | 从 WorkUnit 中提取可复用模式并生成提案（saveProposal 经 submitSkillProposal 发卡）；P4.3 后无 HTTP 消费方（原 proposals 路由已删），service 与 skill-extraction-events 测试保留 |
| selectSkills | skill-selector.ts | 三层策略技能匹配：声明 triggers 时匹配 triggers（替代长 description），否则匹配 description（排除 NOT-for）；consumers 含 loop 的 skill 不参与 |
| selectSkillsWithDomain, parseSkillHintsFromScope | skill-selector.ts | 决策 7/8/11：相关度排序器（显式 +hints > 域匹配（阶段词表归一化）> scope 匹配 > 其余按热度/名称序），全量不封顶（调用方按预算截断）；+skill 从 scope 解析 |
| selectSkillsForInjection | skill-selector.ts | #92（#88）：skills 索引硬预裁剪 —— 只返回 hint（+skill 点名）+ role.skills 显式声明（#462，第 4 参 roleSkills，与 +skill 同权、排 hint 之后域匹配之前）+ 域匹配三类（按 name 去重、hint 置顶）；scope 文本匹配与 rest 热度不进注入段（段尾 MANIFEST 指针按需兜底）。复用 selectSkillsWithDomain 的 active/hint/域匹配口径（normalizeToStage 归一化） |
| GET /skills/manifest | routes.ts | #462：skills MANIFEST 只读清单（name/description/agentTypes/triggers），角色编辑 UI 的 skill 多选数据源；loop-consumer 不进候选（与注入口径一致）；注册在 /:id 之前 |
| SkillRecord, SkillCreateInput, SkillUpdateInput | skill-store.ts | 技能元数据的类型定义及文件型 CRUD |
| LoadedSkill, SessionSkillState, LoadSkillOptions | skill-loader.ts | 技能加载相关的类型定义；#361 起磁盘加载归 `@dommaker/studio-skill` 包加载器（loadSingle），本文件只留会话级 load 缓存 + skill_used 事件发射（第三份 frontmatter 解析器已删） |
| aggregateSkillUsage, scanSkillDemotions, approveDemotion, rejectDemotion, DemotionProposalStore | skill-demotion.ts | §10.6 降级通路：skill_used 事件 + WU 终态聚合 → 降级提案（只提案不自动生效；approve 改 frontmatter status，正文逐字节保留）；票 D 起 successRate 使用归因（usedWuIds ∩ 终态）+ exposures 曝光计数仅展示；提案存 ~/.studio/data/skills/demotion-proposals.json；P4.3 后无 HTTP 消费方（原 demotion-proposals 路由已删，scan 由 bootstrap/bridges.ts 直调），service 与 skill-demotion 测试保留 |
| initSessionPatternSuggest | session-pattern-suggest.ts | KE-001 P5（#687 依赖倒置自 events/session-summary-generator 迁入）：订阅 eventBus 'session:summary'（events 落盘后发布，events 不 import 本模块）——同一 patternType 30d 内 ≥3 次且无同模式 Skill → skillStore 建 proposal 草稿；bootstrap/bridges.ts 装配，幂等 |
| SkillUsageScanner, initSkillUsageScan, extractUsedSkillNames | skill-usage-scan.ts | 度量地基票 B：WU done → skill-usage 独立 watermark 读 committed 增量，扫 rawOutput 中 `skills/<name>/SKILL.md` 痕迹 → 每 skill 一条 skill_used；全部事件写成功才推进水位，启动续扫恢复；纯确定性零 LLM，#703 起仅真实进入 done 触发，聚合侧 (skill, WU) 去重吸收重复触发 |

### 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared`（多个文件：logger、FileStore、modelGateway；#361 起 writeStudioEvent 经 utils 薄壳）
- `@dommaker/studio-skill`（skill-loader.ts 的 skillLoader.loadSingle 磁盘加载；SkillTier 类型）
- `express`（routes.ts 中的 Router）
- Node.js 内置模块：fs、path、os、crypto
- `../channels/index.js`（routes.ts 的 retract/decide 路由经 getChannelMessageService 回写卡片 meta）
- `../review-proposal/index.js`（review-adapter.ts 接线正本：createJsonlReviewAdapter 工厂）
- `./skill-store.js`、`./review-adapter.js`（内部跨文件引用）

**下游（谁依赖本目录）**
- `apps/api/src/modules/agents`（auditor-execution.ts、auditor-rules.ts）
- `apps/api/src/modules/knowledge`（pattern-miner.ts）
- `apps/api/src/modules/mcp`（skill.tools.ts）
- `apps/api/src/modules/workunit`（workunit.service.ts）
- `apps/api/src/route-registry.ts`

### 注意事项

- 所有数据存储已从 Prisma 迁移至文件系统（D-005），无数据库依赖
- **fs 直写保留理由（P2-e 登记）**：SkillStore（`skills-index.json`）与 DemotionProposalStore（`data/skills/demotion-proposals.json`）是模块自持同步 store（契约 §8/§2① 登记条目，布局冻结）；同步 API 全链路调用方未异步化，不改写为 FileStore 域方法。SKILL.md 读写/`_deprecated` 目录移动是 markdown/目录形态，FileStore 不管；路径均经 `studioPath()`/`SKILLS_DIR` env。
- SKILL.md 文件采用 frontmatter 格式，存放于 `~/.studio/skills/` 目录；技能索引存于 `~/.studio/skills-index.json`；提案存取自 #354 起归 review-proposal 正本，落 `~/.studio/skill-proposals.jsonl`（append-only + 状态墓碑折叠，词表 pending|executed|rejected|failed|card-failed）。旧自持存储 `~/.studio/proposals.json` 随 proposal-store.ts 退役：历史文件不改写不迁移，其中存量 pending 提案不再进入待审列表
- `loadManifest()` 使用内存缓存，变更需重启进程或重新调用清除缓存
- 路由文件导出 open/write 双 Router 实例，由 route-registry 挂在同一挂载点 /api/v1/skills（open 读开放，write 挂 authNotGuest）
- skill-selector 匹配时会排除 `NOT-for` 子句，避免排除项关键词触发误匹配
- 技能加载器按 SKILL.md frontmatter 的 `tier` 字段记录技能层级（fast/standard/premium）
- 所有日志使用 `@dommaker/studio-shared` 的 logger 实例，统一日志格式
- SkillStore 是模块级单例 + 固定 `~/.studio` 存储路径（无构造注入）——测试须 mock fs 或整个模块（distill-landings / skill-extraction-events 测试同做法）；蒸馏 skill 落地经 `modules/distill/distill-landings.ts` 调 skillStore + submitSkillProposal（#145/#354）。#354 前 skill-extraction 发 skill_review_request 卡直传字面 `system` 作 channelId 的口径问题已随正本接线消除（正本统一解析 #系统 频道取真 id）。
- **鉴权（2026-07-24 收紧；P2-e 声明式统一；P4.3 收窄）**：routes.ts 拆 open/write 双 router——GET / 与 GET /manifest 读开放，POST /:id/retract/decide 由 route-registry write entry 挂 authNotGuest，路由内不挂鉴权。历史遮蔽问题（GET /skills/proposals、GET /stats 被 /:id 吞）随 P4.3 端点删除与 route-registry assertRouteOrder 约束一并退役——/:id 参数路由本身已删，前提不复存在。
- **契约驱动（2026-10 批次 3/7；P4.3 收窄）**：routes.ts 走 core/http.ts defineRoute（契约 packages/studio-contract/src/skills.ts），存活端点 wire：GET / 列表统一分页壳 `{ data, pagination }`（原平铺 `{ data, total, page, limit }`）、GET /manifest 与 POST /:id/retract/decide 带 `{ data }` 壳；retract/decide 的 decision guard 收进 zod enum（原手写文案 → BAD_REQUEST）。P4.3 删除的 16 条端点契约（discover/stats/CRUD/usage/publish/deprecate/restore、proposals、demotion-proposals 全组）已从契约文件同步移除。
- **retract 决策闭环（#278，决策 #250 D2）**：`POST /:id/retract/decide {decision, messageId?, channelId?}`（routes.ts）补上 retract 下半截——守卫 `status==='under_review'`，confirm→`deprecated`、reject→`published`；messageId 提供时经 `getChannelMessageService().updateMessageMeta` 回写 retract_confirm 卡 meta.status（非阻断）；#524 P1-1 起 channelId 可选透传（前端 useChannelCardActions 带上）→ 回写按频道直查免全频道扇出，缺省保留扇出兼容。上半截 retract 动作原在 skill-proposal-routes.ts（P4.3 已删），retract_confirm 卡改由 review-proposal 正本驱动；本端点守卫 under_review 状态，正本审批路径仍能闭环到此处。
- **手改 SKILL.md 后一次性重生成 MANIFEST.md（#306，2026-08-24）**：在 `apps/api` 目录内用 tsx 跑临时脚本调 `generateManifest()`（manifest-generator.ts:54）——脚本必须放项目目录内，tsx 按脚本位置解析相对导入，放 /tmp 会 MODULE_NOT_FOUND。免手工路径：API 启动时 seed hash 有变更自动重生成。
- **CLI 流动三件套（#568）**：`studio skill validate/export/install` 落 `apps/api/src/cli/skill.ts`（纯本地文件操作，daemon 离线可用）；install 只落目录不写 skills-index.json（与 seed 对齐：目录即注册，REST CRUD 面看不到 install 来的 skill，语义与内置 skill 一致）。
