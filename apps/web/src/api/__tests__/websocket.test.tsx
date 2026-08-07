/**
 * WebSocketProvider — 单一 SSE 连接不变量（2026-08 旧 realtime 链路清理）
 * 应用根部有且仅有一个 EventSource（/events/stream），事件统一经 context.onEvent 分发
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  static instances: FakeEventSource[] = [];

  url: string;
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

vi.stubGlobal('EventSource', FakeEventSource);

import { WebSocketProvider } from '../websocket';
import { useWebSocketContext } from '../websocketHooks';

let ctx: ReturnType<typeof useWebSocketContext> | null = null;

function Probe() {
  ctx = useWebSocketContext();
  return null;
}

function renderProvider() {
  return render(
    <WebSocketProvider>
      <Probe />
    </WebSocketProvider>
  );
}

beforeEach(() => {
  FakeEventSource.instances = [];
  ctx = null;
});

describe('WebSocketProvider — 单连接不变量', () => {
  it('挂载时只建立一个 EventSource，指向 /events/stream', () => {
    renderProvider();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toMatch(/\/events\/stream$/);
  });

  it('卸载时关闭唯一连接', () => {
    const { unmount } = renderProvider();
    const es = FakeEventSource.instances[0];
    unmount();
    expect(es.closed).toBe(true);
  });

  it('SSE 消息经 context.onEvent 分发给订阅者', () => {
    renderProvider();
    const received: string[] = [];
    let unsub: () => void = () => {};
    act(() => {
      unsub = ctx!.onEvent((msg) => received.push(msg.event_type));
    });
    act(() => {
      FakeEventSource.instances[0].onmessage?.({
        data: JSON.stringify({
          event_id: 'e1',
          event_type: 'workunit.status_changed',
          timestamp: new Date().toISOString(),
          data: {},
        }),
      });
    });
    expect(received).toEqual(['workunit.status_changed']);
    act(() => unsub());
  });
});
