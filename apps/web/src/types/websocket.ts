// SSE 客户端类型（P3-a 自 api/websocketHooks.ts 迁出——api 层不声明导出类型）。
// #665（ADR 2026-08-24 落地）：信封类型与 studio-contract 同源（sse-events.ts），
// 本地声明清零——WebSocketMessage 为契约 SseEventEnvelope 的别名 re-export，
// 消费方 import 路径不变。payload 判别联合（sseEventSchema）为运行时校验正本。
import type { SseEventEnvelope } from '@dommaker/studio-contract';

/** SSE 事件信封（/events/stream 每行 data 解析后）= 契约 loose 信封 */
export type WebSocketMessage = SseEventEnvelope;

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
