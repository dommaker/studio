// types/websocket.ts — SSE 信封类型锚定测试（P3-a）：
// 信封形状 + api/websocketHooks.ts re-export 同一性。
import { describe, it, expect } from 'vitest';
import type { WebSocketMessage, WebSocketStatus } from '../websocket';
import type { WebSocketMessage as FromHooks, WebSocketStatus as StatusFromHooks } from '../../api/websocketHooks';

describe('types/websocket（SSE 信封）', () => {
  it('WebSocketMessage 信封四字段', () => {
    const msg: WebSocketMessage = { event_id: 'e-1', event_type: 'channel.message_sent', timestamp: '2026-10-02T00:00:00Z', data: { x: 1 } };
    expect(msg.event_type).toBe('channel.message_sent');
    expect((msg.data as { x: number }).x).toBe(1);
  });

  it('WebSocketStatus 词表 + websocketHooks re-export 同一性', () => {
    const states: WebSocketStatus[] = ['connecting', 'connected', 'disconnected', 'error'];
    const viaHooks: StatusFromHooks[] = states;
    expect(viaHooks).toHaveLength(4);
    const env: FromHooks = { event_id: 'e', event_type: 't', timestamp: 'ts', data: null };
    expect(env.data).toBeNull();
  });
});
