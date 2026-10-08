// types/sse.ts — SSE 信封类型锚定测试：
// #665 起信封与 studio-contract 同源（SseMessage = SseEventEnvelope 别名），
// 此处锁定别名同一性 + api/sseHooks.ts re-export 同一性 + SseStatus 词表。
import { describe, it, expect } from 'vitest';
import { sseEnvelopeSchema, type SseEventEnvelope } from '@dommaker/studio-contract';
import type { SseMessage, SseStatus } from '../sse';
import type { SseMessage as FromHooks, SseStatus as StatusFromHooks } from '../../api/sseHooks';

describe('types/sse（SSE 信封，契约同源）', () => {
  it('SseMessage = 契约 SseEventEnvelope（别名同一性，双向可赋）', () => {
    const msg: SseMessage = { event_id: 'e-1', event_type: 'channel.message_sent', timestamp: '2026-10-08T00:00:00Z', data: { x: 1 } };
    const asContract: SseEventEnvelope = msg;
    const back: SseMessage = asContract;
    expect(back.event_type).toBe('channel.message_sent');
    // 契约 loose 信封运行时校验可用（event_id/data 可缺省，event_type 必填）
    expect(sseEnvelopeSchema.parse({ event_type: 't' }).event_type).toBe('t');
  });

  it('SseStatus 词表 + sseHooks re-export 同一性', () => {
    const states: SseStatus[] = ['connecting', 'connected', 'disconnected', 'error'];
    const viaHooks: StatusFromHooks[] = states;
    expect(viaHooks).toHaveLength(4);
    const env: FromHooks = { event_id: 'e', event_type: 't', timestamp: 'ts', data: null };
    expect(env.data).toBeNull();
  });
});
