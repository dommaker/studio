// types/sse.ts — SSE 信封类型锚定测试：
// #665 起信封与 studio-contract 同源；#690 起 SseMessage = 已校验词表事件 | loose 信封联合
// （运行时校验件 parseSseMessage/isSseEvent 归 api/sseHooks.ts，锚定测试在 api/__tests__/sseParser.test.ts）。
import { describe, it, expect } from 'vitest';
import { sseEnvelopeSchema } from '@dommaker/studio-contract';
import type { SseMessage, SseStatus } from '../sse';
import type { SseMessage as FromHooks, SseStatus as StatusFromHooks } from '../../api/sseHooks';

describe('types/sse（SSE 信封类型，契约同源）', () => {
  it('SseMessage 接受 loose 信封成员（词表外透传形状）', () => {
    const loose: SseMessage = { event_id: 'e-1', event_type: 'runtime.x', timestamp: '2026-10-08T00:00:00Z', data: { x: 1 } };
    expect(loose.event_type).toBe('runtime.x');
    // 契约 loose 信封运行时校验可用（event_id/data 可缺省，event_type 必填）
    expect(sseEnvelopeSchema.parse({ event_type: 't' }).event_type).toBe('t');
  });

  it('SseStatus 词表 + sseHooks re-export 同一性', () => {
    const states: SseStatus[] = ['connecting', 'connected', 'disconnected', 'error'];
    const viaHooks: StatusFromHooks[] = states;
    expect(viaHooks).toHaveLength(4);
    const env: FromHooks = { event_id: 'e', event_type: 't', timestamp: 'ts', data: null };
    expect(env.event_type).toBe('t');
  });
});
