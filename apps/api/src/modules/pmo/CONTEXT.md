# apps/api/src/modules/pmo

### 职责

项目管理办公室（PMO）：OKR 管理 + 项目 CRUD + 交付守卫。PMO 是链条脊椎：id = 分支名、需求文档挂载点、状态 = WU 汇总 + 证据台账、交付策略挂在项目上。统一编号 PMO-<n>。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `getCurrentQuarter` / `OKRService` / `okrService` | `okr.service.ts` | OKR 核心 + 季度计算 + 单例 |
| `OKRMetricQueries` | `okr-metric-queries.ts` | OKR 数据源查询基类，22 个 metric 查询 + `checkDataSourceHealth` |
| `projectService` | `project.service.ts` | 项目服务单例（`getByReqAlias`/`getByPmoNumber`/`ensureChoreProject`/`findChoreProject`/`publish`） |
| `generatePmoNumber` / `parsePmoSeq` | `project.service.ts` | 统一编号 max(PM/PMO,REQ)+1，格式 PMO-<n> |
| `resolveDeliveryPolicy` | `project.service.ts` | 交付策略缺省解析（默认 branch-only） |
| `resolveDeliveries` / `PmoMap` / `DeliveryLeg` / `LEG_STATUS` | `project.service.ts` | 探路地图 + 多交付腿模型（pending->active->in_review->completed->delivered） |
| `parsePmoNumberFromCommand` / `PROJECT_STATUS` | `project.service.ts` | 命令解析 PMO 号 + 项目状态枚举 |
| `initPmoProgressRollup` / `syncProjectProgress` / `waitForPmoProgressRollupSettled` / `rollupTiming` | `progress-rollup.ts` | 订阅 WU 状态变化回写 progress + 状态翻转；#282 起 progress 分子 = workFinished（done/closed，与 WU 完成管道同源），翻转判定仍按 TERMINAL（派生链未落定不翻 completed）；#410 起事件侧走 per-project 聚合 memo + 50ms 去抖（稳态零存储读，见「运行时约定」） |
| `selectProjectSnapshots` / `summarizeEvidence` / `matchWuToLeg` / `partitionSnapshotsByLeg` / `CODE_TYPES` / `EvidenceWuInput` / `buildReqProjectMap` | `evidence-summary.ts` | 共享证据口径：快照派生 l1/l2/l3 + deliverable 判定 + WU->腿归属；归属 = #402 逐 WU 解析（reqId 绑定优先 -> pmoId 戳兜底 -> 未归属，单 WU 不双计，REQ 链命中不丢弃戳归属 WU）；`EvidenceWuInput` = 归约口径消费的最小字段集（id/status/type/metadata，progress-rollup memo 与全量快照均可喂入） |
| `AnalysisHandoff` / `initAnalysisHandoff` / `waitForSettled` | `analysis-handoff.ts` | analysis/plan（#471）->in_review 分流确认（有频道=人工确认卡，无频道+trigger=直转）+ 建 task 子 WU |
| `DecisionResolution` / `initDecisionResolution` | `decision-resolution.ts` | 决策单状态推进 + 落 decisions[] + 雾消解 + 全清自动建 spec 单（#471 起只服务存量在飞链——新链不再派生 decision WU）；#457 起事件路径零防御性重读（payload 即真相：reviewPassed 台账 l3 与 done 迁移同一快照原子落盘后发布，pmoId/fogId 建单落档不可变；map 写围栏在 projectId 串行链上） |
| `MapOpening` / `initMapOpening` / `parseMapOpening` | `map-opening.ts` | analysis/plan done -> 初始化探路台账（提取 DESTINATION:/FOG: 清单，#401 起兼容中文别名 目标：/待决：）；#471 起降级为纯台账——不再逐条建 decision 单，fog[].wuId 恒 null |
| `applyPlanRuling` / `validateRulingItems` / `PlanRulingError` | `plan-ruling.ts` | #467 裁决轮提交唯一正本：一次性裁决（采纳/打回重议）批量落探路台账（decisions[] + fog resolved/open，map 未建就地初始化）+ 组合结果文本复活 plan 同会话（pendingReplies 注入） |
| `SpecMaterialization` / `initSpecMaterialization` / `parseSpecTasks` / `serializeSpecTasks` | `spec-materialization.ts` | spec done -> 批量建 task 子 WU（提取 TASK:/AC:/BLOCKEDBY:/LEG: 清单；#471 起只服务存量 spec 单）；#463 起哨兵改「无 TASK 行不落档」（人审有意不物化 ≠ 未处理，补确认可再触发），serializeSpecTasks 为确认表单后端序列化出口（parse 逆运算） |
| `getDeliveryStatus` / `deliverProject` / `markProjectDelivered` | `delivery.ts` | 交付台账（证据齐缺 + gaps）+ auto-merge 交付（逐腿独立合并）+ #469 branch-only 人工落档（填 commit 写 deliveredAt/By/Commit，幂等拒绝重复，成功发播报）；#376 起响应带 `archived`（终态项目实时重算零 WU = 历史任务数据已清理，前端显示归档提示而非全 0）；#469 起响应带 `channelId`（交付播报取数） |
| `postProjectMilestone` | `delivery-notify.ts` | #469 项目里程碑出声统一出口：频道面（channelId 非空 → 'Studio' 系统消息，meta pmoId+atHuman）+ 持久面（createForAllUsers type 'system'，link `/pmo/project/:id`），全程 best-effort |
| 默认导出 Express Router | `routes.ts` | REST 路由（`/project`、`/objective`、`/key-result` 等） |

### 依赖关系

**上游**：`@dommaker/studio-shared`、`../../utils/logger.js`、`../../middleware/auth.js`、`../../middleware/api-cache.js`、`../channels/channel-message.service.ts`、`../workunit/workunit.service.ts`、Node 内置 `os`/`path`/`fs`

**下游**：`agents`（`auditor-rules.ts`）、`channels`（`channel.routes.ts`）、`mcp`（`pmo.tools.ts`）、路由注册（`route-registry.ts`）

### 运行时约定

- 项目数据存储在 `~/.studio/projects/{id}.json`，OKR 数据存储在 `~/.studio/okr/` JSONL 文件。所有服务基于 FileStore。
- 统一编号：新 PMO 编号 = max(PM/PMO, REQ 两序列)+1，格式 PMO-<n>（分支名）；`reqAlias` 同号；存量 PM-XXX/REQ-XXXX 不迁移。
- 交付策略 `deliveryPolicy`：`branch-only`（默认，只标记不碰链路）/ `auto-merge`（人工触发，证据齐才合并 PMO 分支 -> 默认分支，不 push）。
- 杂务 PMO：`isChore + channelId` 联合标识，`ensureChoreProject` find-or-create。
- 多腿项目：`POST /project` 接受 `gitRepos: string[]`，每个工程落一条 `deliveries[]` 腿。
- 鉴权：6 条写端点 requireAuth+requireNotGuest，DELETE project/okr requireRole('Admin')。
- **OKR 缓存与冲突语义（#448，2026-09-02）**：`GET /okr` 挂 30s apiCache，OKR 写端点（POST/PUT/DELETE `/okr*`）成功后 `clearCache(baseUrl + '/okr')` 写后失效；`POST /okr` 季度撞重（`okrService.create` 抛 "already exists"）映射 409 CONFLICT（按 message 映射 status，同 publish 路由先例），其余 service 错误仍 500 INTERNAL_ERROR。
- **未归属 WU（#402 决策）**：无 reqId 且 pmoId 归因戳解析为 null 的 WU——不计入任何项目的交付统计，但 API 层可过滤/计数/列清单。trigger 系统维护单等合法无归属，创建入口不强制归因（best-effort 落戳）。#402 存量不 backfill（生产 REQ.projectId 全空、戳覆盖极低，无可推导补差集，同 #376 存量决策）；REQ 解绑不拦截（解绑语义），无戳关联 WU 失去归属时 requirement.service 记 warn 供对账。
- **gitRepo 白名单（2026-08-25 收口）**：`POST /project` 与 `PUT /project/:id` 校验 `gitRepo`/`gitRepos`——resolve 后须落在允许根（env `PMO_GIT_REPO_ROOTS` 冒号分隔，缺省 `/root/projects`）且为已存在目录，否则 400 INVALID_INPUT。写入口仅此两处（`updateStatus` 不触 gitRepo）。
- **派生链收敛（#471，2026-09-09）**：publish 只建一张 `type='plan'` 一脉会话规划单（scope 首行钉 `+requirement-clarify +to-tickets`，metadata 落 `tokenBudget`（env `STUDIO_PLAN_TOKEN_BUDGET`，默认 1M））；analysis/decision/spec 三段派生退役——map-opening 降级为纯台账（不再建 decision 单），decision-resolution/spec-materialization 只服务存量在飞链。plan 确认/派工走 analysis-handoff 同一管线（metadata 字段名 analysisTasks/analysisFog/analysisDestination 不变）；plan 步数额度 PLAN_STEP_LIMIT=60（workunit.types.ts），到线挂 blocked 转人续期（waitingReason='plan-step-limit'，waiting-input 回复即 allowance+60）；plan 入 MANUAL_GATE_TYPES（不派自动评审/豁免 l2/不出评审建议片）、豁免超时扫描与死信自动关闭，但走全局状态机（保留 closed，预算三选「放弃」需要）。derivationPending 判①仅旧链在飞（fog 含 wuId）才阻断，判② analysis 扩为 analysis/plan。失败恢复：plan 新会话以 prompt「探路地图」段的 map 台账为唯一恢复事实源（prompt-composer 按 pmoId 注入，零新机制）。
- **建单指派路由（#466，2026-09-09）**：publish 建 plan 单与 analysis-handoff TASK 拆派工（spawnTasks + respawnScopes 对账补建同口径）均查频道路由表（channels/routing.ts，plan/implement 档）落 assigneeId——publish 显式 assigneeId、确认弹窗 defaultTaskAssigneeId 均优先于路由；路由配置失效（inactive/移出频道/已删除）→ 回池涌现 + 频道出声提醒（respawnScopes 按决议 5 不出声）。评审档在 agents/loop/review-dispatcher。
- **裁决轮（#467，2026-09-09）**：plan 会话内一次性人闸——fog 调研齐后 agent 出 `ACTION: NEED_INPUT:裁决轮…` + 紧随 `RULING: {"question","suggestion","default"?}` 行（parser 落 `metadata.planRulings` + `waitingReason='plan-ruling'`，里程碑消息 `meta.cardType='plan_ruling'` 接力卡）；人经 `POST /workunits/:id/ruling`（或前端 PlanRulingDialog）一次提交 → `applyPlanRuling` 批量落账（采纳题 decisions[] 追加 + fog resolved，条目缺失按 question 补建，wuId 恒 null；map 未建就地初始化 destination=项目标题；幂等 = 已 resolved 且同 wuId+同结论不双写）→ 组合裁决结果文本经 resumeWaitingWorkUnit 注入 pendingReplies 复活同会话。落账后 prompt-composer map 段自然把已裁决结论注入后续 prompt（spec 成文上下文零搬运）。无 FOG 小需求不进裁决轮（契约文案约束）。注意：ruling 初始化的 map 不带 mapOpenedAt 哨兵，done 时 map-opening 见 map 已存在 early-return（哨兵不落 = F6-b 补确认仍可补 FOG，语义同现状）。
- **progress-rollup memo（#410，2026-08-31）**：事件消费侧 = 进程内 per-project 聚合 memo（项目兄弟 WU 的 `EvidenceWuInput` 最小字段集），事件负载（snapshotToData 全量数据）增量喂入，稳态零存储读（不再每事件 `reqService.list()` + `getIndex()` 全量克隆）。规则：① `workunit.created` 只记账不触发归约（感知 created 直落非终态的新增 WU）；触发口径不变（reqId 路径仅 REQ 已绑定才触发，戳路径命中即触发，REQ 未绑定有戳只记账）。② 冷启动首个归约回源一次，之后纯增量；回源顺带重建 REQ 归属缓存（按 FileStore 分桶，只缓存正向绑定）。③ 同项目 50ms 去抖合并为一次归约（`rollupTiming.debounceMs` 测试可调），串行化仍由 syncChains 承载（2026-09-10 收口：五处 per-key 链式串行化拷贝统一为 keyed-enqueue.ts 的 createKeyedEnqueue，syncChains/enqueue 等本地实现已删，语义不变——各模块持独立实例不跨模块共链）；`waitForPmoProgressRollupSettled` 语义不变。④ 派生哨兵（analysisTasksSpawnedAt/specTasksSpawnedAt）落档不发事件，memo 判「未落定」时回源复核一次（哨兵只增不减，memo 判「已落定」必为真；#463 起 spec 哨兵改「无 TASK 行不落档」，derivationPending 判③同步按 l3.summary 有无 TASK 行区分未处理与有意不物化）。⑤ 直调路径（`syncProjectProgress` 导出：routes GET 读取纠偏/测试）恒回源，语义 = 原全量读。已知接受项：WU delete 无事件，memo 靠回源自愈；进程重启冷启动即可（memo 不跨进程）。
- **完成/交付感知闭环（#469，2026-09-10）**：progress-rollup 翻 completed/in_review（单腿/多腿 4 个站点）除 logger 外经 `postProjectMilestone` 出声——频道里程碑（meta pmoId+atHuman）+ 持久通知（type 'system'，link `/pmo/project/:id`）；deliver 成功（auto-merge 单腿/多腿）与 `markProjectDelivered`（branch-only 人工落档，路由 `POST /pmo/project/:id/mark-delivered`，human-only、commit 必填 400、auto-merge/已落档 409）发交付播报（pmoNumber + commit 短哈希 + 腿数 + 操作人）。全部 best-effort 不阻断主路径；未 publish（无 channelId）项目只落通知不发帖。
