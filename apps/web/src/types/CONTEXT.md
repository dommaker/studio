# apps/web/src/types

### 职责

客户端本地类型正本目录（P3-a 设立）。api 层（`api/*.ts`）经 `local/no-hand-copied-api-types`
eslint 规则（error）禁止声明导出类型——REST 类型唯一正本在 `@dommaker/studio-contract`；
不属于契约的纯客户端类型（UI 本地标记扩展）统一住本目录，
api 层需要时经 `export type { X } from '../types/...'` re-export，消费方 import 路径不变。
#665（ADR 2026-08-24 落地）起 SSE 事件信封与事件负载也归契约（`studio-contract/sse-events.ts`），
本目录只剩「契约形状 + 客户端本地标记」的扩展与纯 UI 词表。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `ChannelMessage` | `channel.ts` | 频道消息 = 契约 wire 形状 + 客户端本地标记（#326 degraded 骨架降级 / #486 pending 乐观回显，服务端不下发） |
| `SseMessage` / `SseStatus` | `sse.ts` | SSE `/events/stream` 事件信封 = 契约 `SseEventEnvelope` 别名 re-export（#665 契约同源，本地声明清零）/ 连接状态词表（纯 UI 词表，非契约） |

### 注意事项

- 本目录只放**类型**（interface/type），不放运行时代码；解析器/工具函数归各自 api 或 utils 模块。
- 新增 REST wire 形状或 SSE 事件负载 → 先去 `@dommaker/studio-contract` 补 schema（SSE 归 `sse-events.ts`），不要在本目录手抄后端契约。
