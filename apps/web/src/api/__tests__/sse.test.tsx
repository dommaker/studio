/**
 * SseProvider — 单一 SSE 连接不变量（2026-08 旧 realtime 链路清理）
 * 应用根部有且仅有一个 EventSource（/events/stream），事件统一经 context.onEvent 分发
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useEffect } from 'react';

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

import { SseProvider } from '../sse';
import { useSseContext } from '../sseHooks';
import { useAuthStore } from '../../stores/authStore';

let ctx: ReturnType<typeof useSseContext> | null = null;

function Probe() {
  const c = useSseContext();
  useEffect(() => {
    ctx = c;
  });
  return null;
}

function renderProvider() {
  return render(
    <SseProvider>
      <Probe />
    </SseProvider>
  );
}

beforeEach(() => {
  FakeEventSource.instances = [];
  ctx = null;
});

describe('SseProvider — 单连接不变量', () => {
  it('挂载时只建立一个 EventSource，指向 /events/stream', () => {
    renderProvider();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toMatch(/\/events\/stream$/);
  });

  it('登录后 SSE URL 携带 ?token=（2026-08-25 SSE 移出 PUBLIC_API，EventSource 无头可用）', () => {
    useAuthStore.setState({ token: 'test-jwt-abc' } as any);
    try {
      renderProvider();
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0].url).toContain('/events/stream?token=test-jwt-abc');
    } finally {
      useAuthStore.setState({ token: null } as any);
    }
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
          event_type: 'workunit:removed',
          timestamp: new Date().toISOString(),
          data: { id: 'wu-1', channelId: null },
        }),
      });
    });
    expect(received).toEqual(['workunit:removed']);
    act(() => unsub());
  });

  // #690：sseEventSchema 接到 onmessage 单点——词表内畸形负载不分发 + 可见 log（不静默）
  it('词表内畸形负载不分发给订阅者 + console.warn 可见（#690 运行时校验接线）', () => {
    renderProvider();
    const received: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      act(() => {
        ctx!.onEvent((msg) => received.push(msg.event_type));
      });
      act(() => {
        FakeEventSource.instances[0].onmessage?.({
          data: JSON.stringify({
            event_type: 'workunit:removed',
            timestamp: new Date().toISOString(),
            data: { channelId: 'ch-1' }, // 缺 id，畸形
          }),
        });
      });
      expect(received).toEqual([]);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain('workunit:removed');
    } finally {
      warn.mockRestore();
    }
  });

  // #690：词表外事件（runtime.* 遗留 / knowledge 桥 payload 键）loose 透传，不受校验拦截
  it('词表外事件 loose 透传给订阅者', () => {
    renderProvider();
    const received: string[] = [];
    act(() => {
      ctx!.onEvent((msg) => received.push(msg.event_type));
    });
    act(() => {
      FakeEventSource.instances[0].onmessage?.({
        data: JSON.stringify({ event_type: 'knowledge.doc_changed', payload: { id: 'd1' } }),
      });
    });
    expect(received).toEqual(['knowledge.doc_changed']);
  });

  // 决策 9（2026-08 SSE 负载加深）：断线重连 → onReconnect 注册回调一次性触发
  it('决策9：首次 onopen 不算重连；断线后再次 onopen 触发 onReconnect 一次', () => {
    renderProvider();
    const calls: string[] = [];
    act(() => {
      ctx!.onReconnect(() => calls.push('reconnect'));
    });
    const es = FakeEventSource.instances[0];
    // 首次连接：不触发
    act(() => { es.readyState = FakeEventSource.OPEN; es.onopen?.(); });
    expect(calls).toEqual([]);
    // 断线（CONNECTING 态 onerror = EventSource 内建自动重连中）→ 重连成功（同一实例再次 onopen）
    act(() => { es.readyState = FakeEventSource.CONNECTING; es.onerror?.(); });
    act(() => { es.readyState = FakeEventSource.OPEN; es.onopen?.(); });
    expect(calls).toEqual(['reconnect']);
  });

  it('决策9：onReconnect 返回的退订函数生效（退订后重连不再触发）', () => {
    renderProvider();
    const calls: string[] = [];
    let unsub: () => void = () => {};
    act(() => { unsub = ctx!.onReconnect(() => calls.push('reconnect')); });
    const es = FakeEventSource.instances[0];
    act(() => { es.readyState = FakeEventSource.OPEN; es.onopen?.(); });
    act(() => unsub());
    act(() => { es.readyState = FakeEventSource.CONNECTING; es.onerror?.(); });
    act(() => { es.readyState = FakeEventSource.OPEN; es.onopen?.(); });
    expect(calls).toEqual([]);
  });
});
