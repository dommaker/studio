# monitoring

> 此文件描述 apps/api/src/modules/monitoring 目录的职责和上下文

## 职责

负责聚合 Agent Network 的监控指标，包括 Agent 摘要、统计信息、飞轮指标（M1）和封装开销（M2），通过 HTTP 路由对外暴露。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `default` (Router) | `monitoring.routes.ts` | Express 路由器，挂载 `/agents`、`/stats`、`/flywheel`、`/overhead` 四个 GET 端点 |
| `MonitoringService` | `monitoring.service.ts` | 监控服务类，封装聚合逻辑，依赖 `KnowledgeMetricsSource` 获取度量数据 |
| `INJECTED_TOKEN_BUDGET` (常量) | `monitoring.service.ts` | 知识/约束注入红线上限：2000 tokens/任务 |
| `OVERHEAD_RATIO_BUDGET` (常量) | `monitoring.service.ts` | 封装开销比红线：0.2（对应总 token 不超过直连 CLI 的 1.2x） |
| `KnowledgeMetricsSource` (接口) | `monitoring.service.ts` | 知识度量源接口，定义 `getFlywheelMetrics` 和 `getAuditReport` 方法 |
| `FlywheelStats` (接口) | `monitoring.service.ts` | M1 飞轮指标类型，包含 quality、hitRate、freshness 等字段 |
| `OverheadStats` (接口) | `monitoring.service.ts` | M2 封装开销指标类型，包含 injectedTokens、executionTokens 等字段 |
| `AgentSummary` (接口) | `monitoring.service.ts` | Agent 摘要类型（定义截断，但已导出） |

## 依赖关系

上游依赖：`@dommaker/studio-shared` 的 `FileStore`；`../knowledge/knowledge-service` 的 `AuditReport` 和 `FlywheelMetrics`；以及 Node 内置 `os` 和 `path`。

下游依赖：`apps/api/src/route-registry.ts`（引用本目录的路由模块）。

## 注意事项

- 所有路由处理函数使用 `async/await`，异常统一捕获并返回 `{ error: { code: 'INTERNAL_ERROR', message } }` 格式。
- 成本红线常量 (`INJECTED_TOKEN_BUDGET`、`OVERHEAD_RATIO_BUDGET`) 与 vision §3 对齐，修改需同步文档。
- `KnowledgeMetricsSource` 接口设计为 DI 注入，默认 lazy 获取生产单例，避免模块加载期副作用。
- 监控数据窗口默认 30 天，由 `KnowledgeMetricsSource` 的 `windowDays` 参数控制。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
