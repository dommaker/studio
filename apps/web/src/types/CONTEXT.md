# apps/web/src/types

### 职责

客户端本地类型正本目录（P3-a 设立）。api 层（`api/*.ts`）经 `local/no-hand-copied-api-types`
eslint 规则（error）禁止声明导出类型——REST 类型唯一正本在 `@dommaker/studio-contract`；
不属于契约的纯客户端类型（SSE 事件信封 / 事件负载 / UI 本地标记扩展）统一住本目录，
api 层需要时经 `export type { X } from '../types/...'` re-export，消费方 import 路径不变。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `ChannelMessage` | `channel.ts` | 频道消息 = 契约 wire 形状 + 客户端本地标记（#326 degraded 骨架降级 / #486 pending 乐观回显，服务端不下发） |
| `WebSocketMessage` / `WebSocketStatus` | `websocket.ts` | SSE `/events/stream` 事件信封四字段 / 连接状态词表（SSE 不在 REST 契约范围） |
| `WorkunitTokenEvent` / `ExecutionStepToolCall` / `ExecutionStepEvent` / `ExecutionStreamChunk` | `workunit.ts` | WU 事件负载形状（`/events` 行 payload + SSE `workunit.execution.stream` chunk，非 workunit REST）；对应解析器留在 `api/workunit.ts` |

### 注意事项

- 本目录只放**类型**（interface/type），不放运行时代码；解析器/工具函数归各自 api 或 utils 模块。
- 新增 REST wire 形状 → 先去 `@dommaker/studio-contract` 补 schema，不要在本目录手抄后端契约。
