# runtime-config

> 此文件描述 apps/api/src/modules/runtime-config 目录的职责和上下文

## 职责

提供 TaskWorker 运行时配置的 HTTP API（GET/POST），配置读写基于 EventStore 实现持久化存储，并返回默认配置或存储中的配置。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` | routes.ts | Express 路由器，处理 `/api/v1/runtime-config` 的 GET（获取配置）和 POST（更新配置）请求 |

## 依赖关系

- **上游**：依赖 `../../core/event-store.js` 获取 `eventStore` 实例；依赖 `@dommaker/studio-shared` 的 `logger` 用于错误日志。
- **下游**：被 `apps/api/src/route-registry.ts` 引用，作为 API 路由注册到应用。

## 注意事项

- POST 请求参数校验：`maxConcurrent` 必须在 1-10 之间，`tokenWarningThreshold` 必须在 1000-100000 之间，否则返回 400 错误。
- 配置键固定为 `studio:worker:config`，存储在 EventStore 中。
- 获取配置时若 EventStore 无值，则返回硬编码默认配置（maxConcurrent: 3, tokenWarningThreshold: 15000, showTokenUsage: true）。
- 更新配置使用合并策略（`...existing`），未传的字段保持原值。
- 错误处理统一返回 JSON 格式错误码（`CONFIG_GET_ERROR`, `INVALID_CONCURRENCY`, `INVALID_THRESHOLD`）。
- **鉴权（2026-07-24 收紧）**：/api/v1/runtime-config 挂载层已收 requireAuth+requireAdmin（TaskWorker 配置写 + /reload 热更）。
