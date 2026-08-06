# monitoring

> 此文件描述 apps/api/src/modules/monitoring 目录的职责和上下文

## 职责

负责聚合 Agent Network 的监控指标，包括 Agent 摘要、统计信息、飞轮指标（M1）和封装开销（M2），通过 HTTP 路由对外暴露。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `default` (Router) | `monitoring.routes.ts` | Express 路由器，挂载 `/agents`、`/stats`、`/flywheel`、`/overhead`、`/overview` 五个 GET 端点 |
| `MonitoringService` | `monitoring.service.ts` | 监控服务类，封装聚合逻辑，依赖 `KnowledgeMetricsSource` 获取度量数据 |
| `MetricsService` | `metrics.service.ts` | D16 指标聚合服务：`getOverviewMetrics({windowDays})`，60s 内存缓存，`invalidateCache()` 测试用 |
| `aggregateOverview` (纯函数) | `metrics.service.ts` | D16 聚合核心（快照 + WU 事件 + 统一事件 + 人类消息 → 九组指标，含 F6 evidence 组），供 service 与单测直接调用 |
| `EvidenceMetrics` (接口) | `metrics.service.ts` | F6 证据台账指标（决策 1）：l1/l2/l3 分层达成、selfReview 率、needsHuman、derivedMismatch 双轨偏差（持续为 0 才可停止手写 in_review）、派生列分布——派生一律过 deriveDisplayState |
| `INJECTED_TOKEN_BUDGET` (常量) | `monitoring.service.ts` | 知识/约束注入红线上限：2000 tokens/任务 |
| `OVERHEAD_RATIO_BUDGET` (常量) | `monitoring.service.ts` | 封装开销比红线：0.2（对应总 token 不超过直连 CLI 的 1.2x） |
| `KnowledgeMetricsSource` (接口) | `monitoring.service.ts` | 知识度量源接口，定义 `getFlywheelMetrics` 和 `getAuditReport` 方法 |
| `FlywheelStats` (接口) | `monitoring.service.ts` | M1 飞轮指标类型，包含 quality、hitRate、freshness 等字段 |
| `OverheadStats` (接口) | `monitoring.service.ts` | M2 封装开销指标类型，包含 injectedTokens、executionTokens 等字段 |
| `AgentSummary` (接口) | `monitoring.service.ts` | Agent 摘要类型；agents 数组含 `roleId`（= AgentProfile.id），前端 AgentDashboard 据此合并 profile 信息（provider 等）；2026-07 PMO-flow UX 起每项另含 `currentWorkUnit{id,title,type,status,claimedAt}` / `pmo{id,pmoNumber,title}` / `channelId`（均可 null，向后兼容） |
| `AgentCurrentWorkUnit` / `AgentPmoSummary` / `MonitoringServiceDeps` (接口) | `monitoring.service.ts` | /monitoring/agents 聚合的当前 WU 快照 / 归属 PMO 摘要 / 可注入依赖（`listProjects`，测试 stub 避免碰真实 ~/.studio/projects） |

## 依赖关系

上游依赖：`@dommaker/studio-shared` 的 `FileStore`；`../knowledge/knowledge-service` 的 `AuditReport` 和 `FlywheelMetrics`；以及 Node 内置 `os` 和 `path`。

下游依赖：`apps/api/src/route-registry.ts`（引用本目录的路由模块）。

## 注意事项

- 所有路由处理函数使用 `async/await`，异常统一捕获并返回 `{ error: { code: 'INTERNAL_ERROR', message } }` 格式。
- 成本红线常量 (`INJECTED_TOKEN_BUDGET`、`OVERHEAD_RATIO_BUDGET`) 与 vision §3 对齐，修改需同步文档。
- `KnowledgeMetricsSource` 接口设计为 DI 注入，默认 lazy 获取生产单例，避免模块加载期副作用。
- 监控数据窗口默认 30 天，由 `KnowledgeMetricsSource` 的 `windowDays` 参数控制。
- **D16 /overview（2026-07-27）**：聚合八组指标（任务流健康/入口转化/人工干预北极星/端到端周期/角色维度/工程质量/Token/告警），数据源 = WU index.json + workunits/events.jsonl + 统一事件文件（D18）+ 频道人类消息；窗口默认 7d（query 1-90 clamp），60s 缓存；数据不足显式 0/null + `source='insufficient-data'` 不编造；每组带 `description` 大白话。
- **鉴权（2026-07-24 收紧）**：`/api/v1/monitoring` 挂载级 `requireAuth()+requireAdmin()`（route-registry）。GET 端点此前无挂载中间件、仅靠 Lurk Wall 大门兜底。
- **/agents 聚合（2026-07-31 PMO-flow UX §6-1）**：`getAgentSummary` 每 agent 附 `currentWorkUnit`（WU 快照，title = metadata.title ?? scope 原样）+ `pmo`（归属链复用 pmo-branch-resolver 的 `resolvePmoProjectIdForWU`，2026-08 归因统一后两级：①创建期直读戳 metadata.pmoId（‖ deprecated legacy ownershipProjectId 同级）②reqId→Requirement.projectId（决策 4 别名镜像：REQ-\d+ 先查项目 reqAlias）；原 ③ metadata.pmoProjectId 级已移除）+ `channelId`。读取效率：WU index / requirements / projects 各读一次后内存 map 匹配（`loadCurrentWuContexts`），不逐 agent 串行读文件；projects 默认 lazy import projectService.list 大页，测试经 `MonitoringServiceDeps.listProjects` 注入。悬空 currentWorkUnitId（WU 已不存在）→ 三字段 null，裸 id 字段保持原样。
