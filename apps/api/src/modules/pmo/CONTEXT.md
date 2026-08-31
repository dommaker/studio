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
| `initPmoProgressRollup` / `syncProjectProgress` / `waitForPmoProgressRollupSettled` | `progress-rollup.ts` | 订阅 WU 状态变化回写 progress + 状态翻转；#282 起 progress 分子 = workFinished（done/closed，与 WU 完成管道同源），翻转判定仍按 TERMINAL（派生链未落定不翻 completed） |
| `selectProjectSnapshots` / `summarizeEvidence` / `matchWuToLeg` / `partitionSnapshotsByLeg` / `CODE_TYPES` | `evidence-summary.ts` | 共享证据口径：快照派生 l1/l2/l3 + deliverable 判定 + WU->腿归属 |
| `AnalysisHandoff` / `initAnalysisHandoff` / `waitForSettled` | `analysis-handoff.ts` | analysis->in_review 分流确认（有频道=人工确认卡，无频道+trigger=直转）+ 建 task 子 WU |
| `DecisionResolution` / `initDecisionResolution` | `decision-resolution.ts` | 决策单状态推进 + 落 decisions[] + 雾消解 + 全清自动建 spec 单 |
| `MapOpening` / `initMapOpening` / `parseMapOpening` | `map-opening.ts` | analysis done -> 初始化探路地图 + 逐条建 decision 单（提取 DESTINATION:/FOG: 清单，#401 起兼容中文别名 目标：/待决：） |
| `SpecMaterialization` / `initSpecMaterialization` / `parseSpecTasks` | `spec-materialization.ts` | spec done -> 批量建 task 子 WU（提取 TASK:/AC:/BLOCKEDBY:/LEG: 清单） |
| `getDeliveryStatus` / `deliverProject` | `delivery.ts` | 交付台账（证据齐缺 + gaps）+ auto-merge 交付（逐腿独立合并）；#376 起响应带 `archived`（终态项目实时重算零 WU = 历史任务数据已清理，前端显示归档提示而非全 0） |
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
- **未归属 WU（#402 决策）**：无 reqId 且 pmoId 归因戳解析为 null 的 WU——不计入任何项目的交付统计，但 API 层可过滤/计数/列清单。trigger 系统维护单等合法无归属，创建入口不强制归因（best-effort 落戳）。
- **gitRepo 白名单（2026-08-25 收口）**：`POST /project` 与 `PUT /project/:id` 校验 `gitRepo`/`gitRepos`——resolve 后须落在允许根（env `PMO_GIT_REPO_ROOTS` 冒号分隔，缺省 `/root/projects`）且为已存在目录，否则 400 INVALID_INPUT。写入口仅此两处（`updateStatus` 不触 gitRepo）。
