# monitoring

> 此文件描述 apps/api/src/modules/monitoring 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/monitoring/CONTEXT.md, apps/api/src/modules/monitoring/metrics.service.ts, apps/api/src/modules/monitoring/monitoring.routes.ts, apps/api/src/modules/monitoring/monitoring.service.ts

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
| `AgentSummary` (接口) | `monitoring.service.ts` | Agent 摘要类型；agents 数组含 `roleId`（= AgentProfile.id），前端 AgentDashboard 据此合并 profile 信息（provider 等） |

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

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `6f263685`: p0): 信任链六项修复 — 失败误判/超时机制/reviewReport回传/告警出口/日志隔离/traceId
- ✅ 2026-07-27: B5 D16 — 新增 metrics.service（aggregateOverview 纯函数 + 60s 缓存）与 GET /overview 端点
- ✅ 2026-07-27: P0 修复 5 — monitoring.service 的 studio-events.jsonl 读路径走 utils/studio-log-path 测试隔离（生产行为不变）
- ✅ 2026-07-24: API 鉴权收紧 — 挂载收 requireAuth+requireAdmin（agent 运行时/统计属内部运营信息）
- ✅ 2026-07 频道角色修复：`getAgentSummary` agents 映射新增 `roleId`，支撑前端 AgentDashboard 与 AgentProfile 合并展示（provider/描述等）
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
