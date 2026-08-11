# pmo

> 此文件描述 apps/api/src/modules/pmo 目录的职责和上下文

## 职责

项目管理办公室（PMO）模块：OKR 管理 + 项目管理（CRUD、统一编号 PMO-<n> 自动生成）+ 交付守卫。PMO 是链条的脊椎（2026-07-28 分析文档 §4.5）：id = 分支名（gitBranch 默认 = pmoNumber）、需求文档挂载点（requirementsDocId）、状态 = WU 汇总 + 证据台账、交付策略（deliveryPolicy）挂在项目上。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `getCurrentQuarter` | `okr.service.ts` | 获取当前季度字符串（如 2025-Q2） |
| `OKRService` 类 | `okr.service.ts` | OKR 核心服务类 |
| `okrService` 实例 | `okr.service.ts` | OKRService 的单例 |
| `OKRMetricQueries` 类 | `okr-metric-queries.ts` | B8 数据源查询基类（`OKRService` 的父类，2026-08-04 从 okr.service.ts 拆出）：路径常量（OKR_DIR/KR_HISTORY_JSONL/EXECUTIONS_JSONL/STUDIO_EVENTS_JSONL）+ `StudioEventRow` + `checkDataSourceHealth` + 22 个 `query*` metric 查询；`querySkillUsageRate` 例外留在 okr.service.ts（B59-003 测试按源码文本断言其位置） |
| `projectService` 实例 | `project.service.ts` | 项目服务单例（含 `getByReqAlias`/`getByPmoNumber`（数字归一）/`ensureChoreProject`/`findChoreProject`） |
| `generatePmoNumber` / `parsePmoSeq` | `project.service.ts` | 统一编号（决策 4：max(PM/PMO, REQ 两序列)+1，新格式 PMO-<n>） |
| `resolveDeliveryPolicy` | `project.service.ts` | 交付策略缺省解析（未设置 = branch-only） |
| `resolveDeliveries` / `PmoMap` / `DeliveryLeg` / `LEG_STATUS` | `project.service.ts` | #107 T1（#106 spec）：探路地图 `map`（destination/decisions/fog，缺省 null = 非探路型）+ 多交付腿 `deliveries`（缺省 = 读取时由 gitRepo/gitBranch 合成单腿、status 从 deliveredAt 派生、不落盘，老项目零迁移；get/list 等全部读取路径统一口径）。#113 T7：腿状态词表 LEG_STATUS（pending→active→in_review→completed→delivered）+ 腿级 deliveredAt/deliverCommit 落档字段 |
| `parsePmoNumberFromCommand` | `project.service.ts` | 从命令中解析 PMO 号 |
| `PROJECT_STATUS` 常量 | `project.service.ts` | 项目状态枚举 |
| `initPmoProgressRollup` / `syncProjectProgress` / `parseWuMetaPmoId`（re-export） | `progress-rollup.ts` | B3a：订阅 workunit.status_changed，按项目下全部 Requirement（含决策 4 别名视图）关联 WU 的完结比例回写 progress（语义=「活干完了多少」，in_review 计入完结）；全部完结按证据翻转（2026-07-30 根因修复）：deliverable → completed，证据缺口 → active/pending 置 in_review（等证据验收，已 in_review 不动，completed/cancelled 不回退；skipValidation 直写）。同项目回写按 projectId 串行化（防相邻事件并发覆盖）；幂等补写证据不产生状态事件，靠 `GET /project/:id` 读取时重算纠偏。**#115 T9 派生链未落定不翻 completed**（`derivationPending`，e2e 走查根因修复）：analysis/spec 单 done 事件触发本回写时派生订阅器（挂载序晚于本订阅）尚未落哨兵/建下游 WU，「全部完结」是假相——命中 ①有 map 未 specSpawnedAt ②已完结 analysis 缺 analysisTasksSpawnedAt ③已完结 spec 缺 specTasksSpawnedAt 即跳过本次 completed/in_review 翻转（多腿含腿状态），progress 照写，待派生落定后下一事件或读取重算再评估。#113 T7 多腿：显式多腿项目走逐腿状态机（腿内全完结+证据齐→腿 completed、缺口→腿 in_review、有在途→腿 active（#115 起 completed/in_review 可回摆——派生物化/补单会让已完结腿出现在途 WU；delivered 腿终态不回写、零 WU 腿不动且不阻断）），腿状态回写 project.deliveries；项目整体翻转条件 = 全部腿 completed/delivered（零 WU 腿视为满足），否则同单腿语义置 in_review；progress 口径不变。单腿（无 deliveries/合成单腿）不走腿路径，行为与现状逐字节一致 |
| `selectProjectSnapshots` / `summarizeEvidence` / `matchWuToLeg` / `partitionSnapshotsByLeg` / `parseWuMetaPmoId`（deprecated 别名）/ `CODE_TYPES` | `evidence-summary.ts` | 共享证据口径（2026-07-30 抽取，delivery 台账与 progress-rollup 状态翻转共用）：归属（Requirement.projectId → reqId 集合，空则回退创建期归因戳）+ 逐快照 deriveDisplayState 派生 l1（仅代码类）/l2（豁免 review/analysis + #108 decision/spec——对齐 review-dispatcher 跳过集，验收闸=人工 L3）/l3 齐缺 + deliverable 判定。2026-08 归因统一：戳 parser 迁至 requirements/wu-pmo-attribution.ts（`parseWuPmoId`，零依赖叶子防循环），本模块仅保留 `parseWuMetaPmoId` 兼容别名；回退过滤口径放宽为 pmoId ‖ legacy ownershipProjectId 同级（pmoId 优先，ownershipProjectId 生产存量为零、实数据行为不变）。#113 T7：WU→腿归属最小口径 `matchWuToLeg`（①workspaceRoot===腿gitRepo ②worktreeBaseRepo===腿gitRepo ③pmoBranch===腿branch，两侧非空才比较，任一命中即归）+ `partitionSnapshotsByLeg`（归数组序首个命中腿；全部不命中=未分腿公共 WU，保守计入每条腿——证据缺口不允许从任何腿的交付闸逃逸） |
| `AnalysisHandoff` / `initAnalysisHandoff` | `analysis-handoff.ts` | PMO 分析接力：订阅 workunit.status_changed——analysis → in_review 频道提示人工确认（ReviewDispatcher 对 analysis 不派自动评审）；→ done（人工确认）按 metadata.analysisTasks 建未指派 task 子 WU 派工（analysisTasksSpawnedAt 幂等；task 继承 analysis 的 workspaceRoot → 归属链接通 per-WU worktree + PMO 分支） |
| `DecisionResolution` / `initDecisionResolution` | `decision-resolution.ts` | #110 T4 决策落地：订阅 workunit.status_changed——decision 单 → active（被认领）对应雾 open → in-discussion（幂等，resolved 不回摆，评审收尾补齐三态）；decision 单 → done（人工确认）把结论文本**原样**（无 LLM 摘要）追加 map.decisions[] + 对应 fog 置 resolved（按 metadata.pmoId 找 PMO、按 metadata.fogId 定位 fog 条目，缺戳/找不到不炸；decisions[] 按 wuId 去重幂等；结论文本 = attestations.l3.summary，未填落空串不拒写）；fog 全 resolved → 自动建未指派 spec 成文单（scope 带 PMO 引用 + metadata.pmoId 溯源，map.specSpawnedAt 哨兵防重、specWuId 回写）；同 PMO map 写按 projectId 串行化（照 progress-rollup） |
| `MapOpening` / `initMapOpening` / `parseMapOpening` / `MAP_OPENING_FOG_MAX` | `map-opening.ts` | #112 T6 开图机制：订阅 workunit.status_changed——analysis 单 → done（人工确认）且 l3.summary 含待决问题清单 → 初始化 map（destination + fog 逐条）→ 逐条建未指派 decision 单（metadata 落 pmoId/pmoNumber/fogId，#110 消费契约）→ 回写 fog[].wuId（互挂）。提取契约（只搬人填文本，无 LLM）：l3.summary 逐行 `DESTINATION: <目的地>`（首条生效，缺省回退项目 title）+ `FOG: <待决问题>`（每行一雾，兼容中文冒号，上限 12 条）。幂等哨兵 metadata.mapOpenedAt（先落档再建单）；无 FOG 行不炸不落哨兵（F6-b 补确认重发 done 事件，补填仍可开图）；已有 map 不重建；同 PMO map 写按 projectId 串行化 |
| `SpecMaterialization` / `initSpecMaterialization` / `parseSpecTasks` / `SPEC_TASKS_MAX` | `spec-materialization.ts` | #115 T9 交稿物化（#106 验收标准 4）：订阅 workunit.status_changed——spec 成文单 → done（人工确认）且 l3.summary 含 TASK 物化清单 → 逐行解析批量建未指派 task 单（频道成员 loop 认领）。提取契约（只搬人填文本，风格照 map-opening）：逐行 `TASK: <标题> [\| AC: <验收>]... [\| BLOCKEDBY: <wuId,...>] [\| LEG: <gitRepo>]`，段内 KEY: value 兼容中文冒号（清单上限 12 条）；AC 多段 → metadata.ac[]（机制只存不解释）、BLOCKEDBY → metadata.blockedBy[]（#109 接单过滤消费）、LEG 命中项目交付腿 gitRepo → metadata.workspaceRoot（#113 matchWuToLeg 腿归属消费；不命中/缺省 → 不落 = 公共 WU）。幂等哨兵 metadata.specTasksSpawnedAt——spec done **恒落档**（形态照 analysis-handoff；确认通过即定稿，清单应在确认时填好），恒落档同时是 progress-rollup「派生链未落定不翻 completed」判定的输入；无 TASK 行不建单、发频道提示可手动拆任务；parentId=spec 单溯源；同 PMO 物化串行化（无 pmoId 按 WU id） |
| `projectService.publish` | `project.service.ts` | 发频道卡片 + 建 analysis WU（scope 含只读约束 + TASK 输出约定；#112 T6 多腿：显式 deliveries > 1 时 scope 注入「多交付腿」段列全部仓库路径，只读约束不变、无 worktree 隔离，单腿/无 deliveries 不注入、scope 与现状逐字节一致）；metadata 落 pmoId/pmoNumber + workspaceRoot=project.gitRepo（B3a 归属链起点，2026-07-30 接通——此前 task WU 无归属根，直接在共享开发仓落地） |
| `getDeliveryStatus` / `deliverProject` | `delivery.ts` | PMO-b 交付守卫：台账（WU 汇总 + l1/l2/l3 证据齐缺 + deliverable，口径走 evidence-summary）与 auto-merge 交付（证据齐才本地合并 PMO 分支 → 默认分支，不 push；branch-only 只标记不碰链路）。台账新增 `tokens`（sumTokensForWorkUnits 按项目 WU id 集求和 studio-events.jsonl 的 workunit:tokens，best-effort 出错按 0）与 `gaps`（已完成但证据有缺口的 WU 明细：id/title（metadata.title 回退 scope）/type/missing 按 l1→l2→l3 有序）。#113 T7 多腿：显式多腿项目台账附 `legs[]`（逐腿独立汇总 wu/evidence/deliverable/missing/gaps/tokens + 腿状态与腿级交付落档），整体 deliverable = 全部腿 deliverable（已 delivered 腿豁免、零 WU 腿不阻断、全项目无 WU 仍不可交付），整体 missing 逐腿带 `[分支]` 前缀；auto-merge 逐腿独立合并/落档（已 delivered 腿幂等跳过、零 WU 腿 skipped-no-wu、一腿失败不阻断他腿、成功的腿照样翻 delivered），全腿交付才写项目级 deliveredAt。单腿不输出 legs 字段，行为与现状逐字节一致 |
| 默认导出 Express Router | `routes.ts` | 提供 `/project`、`/objective`、`/key-result` 等 REST 路由（含 `GET /project/:id/delivery`、`POST /project/:id/deliver`（human-only）） |

## 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared`（FileStore、logger、parseFrontmatter 等）
- `../../utils/logger.js`
- `../../middleware/auth.js`（requireNotGuest、requireRole）
- `../../middleware/api-cache.js`（apiCache）
- `../channels/channel-message.service.ts`
- `../workunit/workunit.service.ts`
- Node.js 内置 `os`、`path`、`fs`

**下游（依赖本目录）**
- `agents` 模块（`auditor-rules.ts`）
- `channels` 模块（`channel.routes.ts`）
- `mcp` 模块（`pmo.tools.ts`）
- 路由注册（`route-registry.ts`）

## 注意事项

- **测试稳定性候选（2026-08-04 记录，未修）**：`__tests__/analysis-handoff.test.ts` 存在一例时序 flake（全量跑偶发，重跑即过）。下批修法方向：与 knowledge-bus-sync flake 一并处理，断言改轮询等待替代固定时序假设。
- 项目数据存储在 `~/.studio/projects/{id}.json`，OKR 数据存储在 `~/.studio/okr/` 目录下的 JSONL 文件中。
- 项目路由已应用 `requireNotGuest` 和 `requireRole` 中间件进行权限控制。
- 统一编号（决策 4 修正版）：新 PMO 编号 = max(PM/PMO, REQ 两序列)+1，格式 PMO-<n>（即分支名）；`reqAlias` 与 pmoNumber 同号（REQ-XXXX 只读别名）；存量 PM-XXX/REQ-XXXX 不迁移（编号重叠；一次性映射脚本已随 2026-08 死代码清理移除）。
- 交付策略 `deliveryPolicy`：`branch-only`（默认，不碰合并/发布链路，只出台账标记）/ `auto-merge`（POST /project/:id/deliver 人工触发，缺证据 409 硬拒，主仓 checkout 非默认分支拒绝，合并冲突不自动 rebase 转人工）。
- 杂务 PMO（决策 2）：`isChore + channelId` 联合标识，`ensureChoreProject` find-or-create（POST /channels/:id/chore-pmo 登记）；热路径只查不建（findChoreProject）。
- **#114 T8 创建端点多工程入参**：`POST /project` 接受 `gitRepos: string[]`（必须字符串数组，否则 400）——每个选中工程落一条显式交付腿 `deliveries[]`（branch 按 pmoNumber 规则合成、显式 gitBranch 可覆盖全腿、status=pending；兼容字段 gitRepo 取首工程）；空白项剔除后为空 = 旧单选行为（不落 deliveries，读取时合成单腿），旧 `gitRepo` 入参行为不变。
- **发起讨论（publish）全链路（2026-07-29 接力补齐）**：pending 项目 publish → 频道发需求消息 + 建未指派 analysis WU（scope 含 TASK 输出契约 + 「只读分析」约束——2026-07-30 走查修复：分析阶段曾直接改目标仓库文件，现 prompt 层明确禁止 Edit/Write/删改命令，结论只以 markdown 回复不落盘）→ 频道成员 loop 认领分析 → COMPLETE 时 agent-loop 解析 `TASK: <任务描述>` 行落 metadata.analysisTasks（parseTaskBreakdown，≤8 条/条 ≤300 字符）→ in_review（不派自动评审，频道提示人工确认）→ 人工「通过」（reviewPassed）→ analysis-handoff 按 analysisTasks 建未指派 task 子 WU（频道成员涌现认领 = 派工）；确认时 summary 填 `FOG:`/`DESTINATION:` 逐行清单 → map-opening 初始化探路地图并逐条建 decision 单（#112 开图机制，提取契约见核心导出表 map-opening 行）→ decision 单逐条确认（l3.summary = 结论）→ decision-resolution 落地 decisions[] + 雾消解，雾全清自动建 spec 成文单（#110）→ spec 确认（l3.summary 填 `TASK: ... | AC: ... | BLOCKEDBY: ... | LEG: ...` 清单）→ spec-materialization 批量物化任务单（#115，ac/blockedBy/腿归属齐全，提取契约见核心导出表 spec-materialization 行）。与交付策略 deliveryPolicy 无关（deliveryPolicy 只被 delivery.ts 交付守卫消费）。
- 所有服务都基于 FileStore（JSON 文件）而非数据库。
- 测试中使用了 mock，注意 mock 目录与测试数据的路径约定。
- **鉴权（2026-07-24 收紧）**：6 条写端点（POST /project、PUT /project/:id、PUT /project/:id/status、POST /project/:id/publish、POST /okr、PUT /okr/:id）已收 requireAuth+requireNotGuest（此前 import 的 requireNotGuest 只声明未使用）；DELETE project/okr 原有 requireRole('Admin') 不变。OKR 写的 roleId 为 body 自声明、checkPermission 据此校验，属已知局限（未修）。PUT /projects/:id/okr 无前端调用方，2026-08-04 删除。
