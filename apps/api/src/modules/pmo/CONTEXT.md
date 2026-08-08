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
| `parsePmoNumberFromCommand` | `project.service.ts` | 从命令中解析 PMO 号 |
| `PROJECT_STATUS` 常量 | `project.service.ts` | 项目状态枚举 |
| `initPmoProgressRollup` / `syncProjectProgress` / `parseWuMetaPmoId`（re-export） | `progress-rollup.ts` | B3a：订阅 workunit.status_changed，按项目下全部 Requirement（含决策 4 别名视图）关联 WU 的完结比例回写 progress（语义=「活干完了多少」，in_review 计入完结）；全部完结按证据翻转（2026-07-30 根因修复）：deliverable → completed，证据缺口 → active/pending 置 in_review（等证据验收，已 in_review 不动，completed/cancelled 不回退；skipValidation 直写）。同项目回写按 projectId 串行化（防相邻事件并发覆盖）；幂等补写证据不产生状态事件，靠 `GET /project/:id` 读取时重算纠偏 |
| `selectProjectSnapshots` / `summarizeEvidence` / `parseWuMetaPmoId`（deprecated 别名）/ `CODE_TYPES` | `evidence-summary.ts` | 共享证据口径（2026-07-30 抽取，delivery 台账与 progress-rollup 状态翻转共用）：归属（Requirement.projectId → reqId 集合，空则回退创建期归因戳）+ 逐快照 deriveDisplayState 派生 l1（仅代码类）/l2（豁免 review/analysis——对齐 review-dispatcher.ts:47 跳过集，analysis 验收闸=人工 L3）/l3 齐缺 + deliverable 判定。2026-08 归因统一：戳 parser 迁至 requirements/wu-pmo-attribution.ts（`parseWuPmoId`，零依赖叶子防循环），本模块仅保留 `parseWuMetaPmoId` 兼容别名；回退过滤口径放宽为 pmoId ‖ legacy ownershipProjectId 同级（pmoId 优先，ownershipProjectId 生产存量为零、实数据行为不变） |
| `AnalysisHandoff` / `initAnalysisHandoff` | `analysis-handoff.ts` | PMO 分析接力：订阅 workunit.status_changed——analysis → in_review 频道提示人工确认（ReviewDispatcher 对 analysis 不派自动评审）；→ done（人工确认）按 metadata.analysisTasks 建未指派 task 子 WU 派工（analysisTasksSpawnedAt 幂等；task 继承 analysis 的 workspaceRoot → 归属链接通 per-WU worktree + PMO 分支） |
| `projectService.publish` | `project.service.ts` | 发频道卡片 + 建 analysis WU（scope 含只读约束 + TASK 输出约定）；metadata 落 pmoId/pmoNumber + workspaceRoot=project.gitRepo（B3a 归属链起点，2026-07-30 接通——此前 task WU 无归属根，直接在共享开发仓落地） |
| `getDeliveryStatus` / `deliverProject` | `delivery.ts` | PMO-b 交付守卫：台账（WU 汇总 + l1/l2/l3 证据齐缺 + deliverable，口径走 evidence-summary）与 auto-merge 交付（证据齐才本地合并 PMO 分支 → 默认分支，不 push；branch-only 只标记不碰链路）。台账新增 `tokens`（sumTokensForWorkUnits 按项目 WU id 集求和 studio-events.jsonl 的 workunit:tokens，best-effort 出错按 0）与 `gaps`（已完成但证据有缺口的 WU 明细：id/title（metadata.title 回退 scope）/type/missing 按 l1→l2→l3 有序） |
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
- **发起讨论（publish）全链路（2026-07-29 接力补齐）**：pending 项目 publish → 频道发需求消息 + 建未指派 analysis WU（scope 含 TASK 输出契约 + 「只读分析」约束——2026-07-30 走查修复：分析阶段曾直接改目标仓库文件，现 prompt 层明确禁止 Edit/Write/删改命令，结论只以 markdown 回复不落盘）→ 频道成员 loop 认领分析 → COMPLETE 时 agent-loop 解析 `TASK: <任务描述>` 行落 metadata.analysisTasks（parseTaskBreakdown，≤8 条/条 ≤300 字符）→ in_review（不派自动评审，频道提示人工确认）→ 人工「通过」（reviewPassed）→ analysis-handoff 按 analysisTasks 建未指派 task 子 WU（频道成员涌现认领 = 派工）。与交付策略 deliveryPolicy 无关（deliveryPolicy 只被 delivery.ts 交付守卫消费）。
- 所有服务都基于 FileStore（JSON 文件）而非数据库。
- 测试中使用了 mock，注意 mock 目录与测试数据的路径约定。
- **鉴权（2026-07-24 收紧）**：6 条写端点（POST /project、PUT /project/:id、PUT /project/:id/status、POST /project/:id/publish、POST /okr、PUT /okr/:id）已收 requireAuth+requireNotGuest（此前 import 的 requireNotGuest 只声明未使用）；DELETE project/okr 原有 requireRole('Admin') 不变。OKR 写的 roleId 为 body 自声明、checkPermission 据此校验，属已知局限（未修）。PUT /projects/:id/okr 无前端调用方，2026-08-04 删除。
