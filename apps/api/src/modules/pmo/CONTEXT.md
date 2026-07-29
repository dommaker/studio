# pmo

> 此文件描述 apps/api/src/modules/pmo 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/pmo/CONTEXT.md, apps/api/src/modules/pmo/okr.service.ts, apps/api/src/modules/pmo/progress-rollup.ts, apps/api/src/modules/pmo/routes.ts, apps/api/src/modules/pmo/okr-anomaly-detector.ts, apps/api/src/modules/pmo/project.service.ts

## 职责

项目管理办公室（PMO）模块：OKR 管理 + 项目管理（CRUD、统一编号 PMO-<n> 自动生成）+ 交付守卫。PMO 是链条的脊椎（2026-07-28 分析文档 §4.5）：id = 分支名（gitBranch 默认 = pmoNumber）、需求文档挂载点（requirementsDocId）、状态 = WU 汇总 + 证据台账、交付策略（deliveryPolicy）挂在项目上。同时包含已停用的 OKR 异常检测功能（默认不启用）。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `getCurrentQuarter` | `okr.service.ts` | 获取当前季度字符串（如 2025-Q2） |
| `OKRService` 类 | `okr.service.ts` | OKR 核心服务类 |
| `okrService` 实例 | `okr.service.ts` | OKRService 的单例 |
| `projectService` 实例 | `project.service.ts` | 项目服务单例（含 `getByReqAlias`/`getByPmoNumber`（数字归一）/`ensureChoreProject`/`findChoreProject`） |
| `generatePmoNumber` / `parsePmoSeq` | `project.service.ts` | 统一编号（决策 4：max(PM/PMO, REQ 两序列)+1，新格式 PMO-<n>） |
| `resolveDeliveryPolicy` | `project.service.ts` | 交付策略缺省解析（未设置 = branch-only） |
| `parsePmoNumberFromCommand` | `project.service.ts` | 从命令中解析 PMO 号 |
| `PROJECT_STATUS` 常量 | `project.service.ts` | 项目状态枚举 |
| `initPmoProgressRollup` / `syncProjectProgress` | `progress-rollup.ts` | B3a：订阅 workunit.status_changed，按项目下全部 Requirement（含决策 4 别名视图）关联 WU 的完结比例回写 progress；全部完结 → completed（best-effort） |
| `getDeliveryStatus` / `deliverProject` | `delivery.ts` | PMO-b 交付守卫：台账（WU 汇总 + l1/l2/l3 证据齐缺 + deliverable）与 auto-merge 交付（证据齐才本地合并 PMO 分支 → 默认分支，不 push；branch-only 只标记不碰链路） |
| `detectAnomalies` | `okr-anomaly-detector.ts` | OKR 异常检测（默认停用） |
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

- OKR 异常检测默认禁用，需设置环境变量 `OKR_ANOMALY_DETECTOR_ENABLED=true` 才能启用。
- 项目数据存储在 `~/.studio/projects/{id}.json`，OKR 数据存储在 `~/.studio/okr/` 目录下的 JSONL 文件中。
- 项目路由已应用 `requireNotGuest` 和 `requireRole` 中间件进行权限控制。
- 统一编号（决策 4 修正版）：新 PMO 编号 = max(PM/PMO, REQ 两序列)+1，格式 PMO-<n>（即分支名）；`reqAlias` 与 pmoNumber 同号（REQ-XXXX 只读别名）；存量 PM-XXX/REQ-XXXX 不迁移（编号重叠，scripts/migrate-req-to-pmo.ts 出映射报告）。
- 交付策略 `deliveryPolicy`：`branch-only`（默认，不碰合并/发布链路，只出台账标记）/ `auto-merge`（POST /project/:id/deliver 人工触发，缺证据 409 硬拒，主仓 checkout 非默认分支拒绝，合并冲突不自动 rebase 转人工）。
- 杂务 PMO（决策 2）：`isChore + channelId` 联合标识，`ensureChoreProject` find-or-create（POST /channels/:id/chore-pmo 登记）；热路径只查不建（findChoreProject）。
- 所有服务都基于 FileStore（JSON 文件）而非数据库。
- 测试中使用了 mock，注意 mock 目录与测试数据的路径约定。
- **鉴权（2026-07-24 收紧）**：7 条写端点（POST /project、PUT /project/:id、PUT /project/:id/status、POST /project/:id/publish、POST /okr、PUT /okr/:id、PUT /projects/:id/okr）已收 requireAuth+requireNotGuest（此前 import 的 requireNotGuest 只声明未使用）；DELETE project/okr 原有 requireRole('Admin') 不变。OKR 写的 roleId 为 body 自声明、checkPermission 据此校验，属已知局限（未修）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `6f263685`: p0): 信任链六项修复 — 失败误判/超时机制/reviewReport回传/告警出口/日志隔离/traceId
- ✅ `782ac0a9`: 路由层防御纵深 — 写操作端点加 requireAuth+requireNotGuest/requireAdmin
- ✅ 2026-07-27: B5 D18 顺手修 — okr.service 读 knowledge:* 事件的时间口径从顶层 `e.timestamp`（StudioEvent 形态下不存在，恒被过滤、指标恒空）改为 getStudioEventTime（createdAt 优先、兼容历史 timestamp），10 处
- ✅ 2026-07-27: B3a 工程归属链（决策 D2）— 新增 progress-rollup.ts：订阅 workunit.status_changed，WU 关联 Requirement 挂 projectId 时按该项目全部关联 WU 完结比例回写 progress（口径同 REQ 汇总 TERMINAL_WORKUNIT_STATUSES），全部完结置 completed（skipValidation 系统直写）；best-effort 不阻断
- ✅ 2026-07-27: P0 修复 5 — executions/studio-events jsonl 读路径走 utils/studio-log-path 测试隔离（生产行为不变）
- ✅ 2026-07-24: 写端点收 requireAuth+requireNotGuest
- ✅ `0d1ef570`: ci): resolve type errors found by package-level tsc build
- ✅ `1ac014a8`: ci): resolve type errors in worktree-resolver + okr.service
- ✅ `13f60e68`: db-removal): migrate 9 more files from Prisma → FileStore (Round 2)
- ✅ `3de4f489`: ops): code review fixes — Infinity filtering + studioEvent write
- ✅ `c013381b`: pmo): AC-10 column index off-by-one + AC-6 test matcher
- ✅ `9f5c871d`: okr): querySkillUsageRate count skills from disk (B59-003)
- ✅ `a1eb8a3d`: OKR queries — rollback_rate N/A + goal_cost use StudioEvent.costUsd
- ✅ `13cf6b7e`: deploy failure event enrichment + metricType registration
- ✅ `36a91ee2`: O2-KR1 注入命中率接线 — consumption 事件 + metric query
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
- ✅ `78c6856d`: Prisma SQLite auto-parses JSON String fields — handle both string and object
- ✅ `403d82df`: B8 cacheHitRate 公式修正 — cacheHit/(cacheHit+input) 替代 cacheHit/input
