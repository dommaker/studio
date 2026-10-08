// SSE 客户端类型（P3-a 自 api/sseHooks.ts 迁出——api 层不声明导出类型）。
// #665（ADR 2026-08-24 落地）：信封类型与 studio-contract 同源（sse-events.ts），本地声明清零。
// #690：SseMessage 升级为「已校验词表事件 | 词表外 loose 信封」联合——sseEventSchema 接到
// es.onmessage 单点解析（parseSseMessage/isSseEvent 运行时件归 api/sseParser.ts，本目录只放类型）。
import type { SseEvent, SseEventEnvelope } from '@dommaker/studio-contract';

/**
 * SSE 广播消息 = 已校验词表事件（SseEvent 判别联合）| 词表外 loose 信封。
 * 不变量：词表内事件必先过 sseParser.parseSseMessage 的 sseEventSchema 校验才会被广播
 * （失败即丢弃），消费点用 sseParser.isSseEvent 按 event_type narrow 后 data 即具名 payload 类型。
 */
export type SseMessage = SseEvent | SseEventEnvelope;

export type SseStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
