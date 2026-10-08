// SSE onmessage 单点校验件（#690）：sseEventSchema 接到 es.onmessage（sseHooks.ts）唯一解析处。
// 词表内事件校验后广播（消费点经 isSseEvent narrow 取型，原 msg.data 裸强转收口）；
// 校验失败可见 log + 丢弃（不静默、畸形负载不进 store）；
// 词表外事件（runtime.* 遗留 / knowledge 桥 payload 键）loose 信封原样透传。
// 独立于 sseHooks.ts 单文件：消费方测试 mock sseHooks（React 连接层）时本模块不受影响。
import {
  SSE_EVENT_TYPES,
  sseEventSchema,
  sseEnvelopeSchema,
  type SseEvent,
  type SseEventType,
} from '@dommaker/studio-contract';
import type { SseMessage } from '../types/sse';

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(SSE_EVENT_TYPES);

/**
 * onmessage 单点解析（#690 接线 sseEventSchema）：
 * - 词表内事件：判别联合校验成功 → SseEvent；失败 → 可见 log + null（畸形负载不进 store）；
 * - 词表外信封（runtime.* 遗留 / knowledge 桥 `payload` 键转发）→ loose 原样透传；
 * - 非信封帧（connection.established 裸帧 / 垃圾）→ null（无消费方，静默丢弃）。
 */
export function parseSseMessage(raw: unknown): SseMessage | null {
  const parsed = sseEventSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const eventType = (raw as { event_type?: unknown } | null)?.event_type;
  if (typeof eventType === 'string' && KNOWN_EVENT_TYPES.has(eventType)) {
    console.warn(`[sse] 词表内事件负载校验失败，已丢弃: ${eventType}`, parsed.error.issues);
    return null;
  }
  const loose = sseEnvelopeSchema.safeParse(raw);
  return loose.success ? loose.data : null;
}

/**
 * 消费点 narrow 谓词：parseSseMessage 保证广播的词表内事件已过判别联合校验，
 * 本谓词是该运行时不变量的类型层入口（narrow 后 msg.data = 具名 payload，免强转）。
 */
export function isSseEvent<K extends SseEventType>(
  msg: SseMessage,
  ...types: K[]
): msg is Extract<SseEvent, { event_type: K }> {
  return (types as readonly string[]).includes(msg.event_type);
}
