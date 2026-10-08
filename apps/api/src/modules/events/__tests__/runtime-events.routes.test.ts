/**
 * runtime-events 路由测试（2026-10 架构精简刀1，自 executions 模块迁入 events 模块）——
 * 真 express server + fetch。钉住：URL 不变（/api/v1/executions/events）、
 * 响应壳 { data: { received: true } } 不变、eventBus 'events' 频道发布信封不变。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eventBus } from '@dommaker/studio-shared';

let server: Server;
let base: string;

beforeAll(async () => {
  const { default: router } = await import('../runtime-events.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/executions', router);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/executions`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(() => {
  // 测试间不残留订阅（eventBus 为进程级单例）
  eventBus.unsubscribeAll('events');
});

describe('runtime-events routes（自 executions 迁入，URL/形状不变）', () => {
  it('POST /events → { data: { received: true } }，事件进 eventBus events 频道', async () => {
    const received: unknown[] = [];
    const handler = (e: unknown) => received.push(e);
    eventBus.subscribe('events', handler);

    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'runtime.heartbeat', executionId: 'r-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { received: true } });

    expect(received).toHaveLength(1);
    const envelope = received[0] as { event_id: string; event_type: string; timestamp: string; data: unknown };
    expect(envelope.event_id).toBe('r-1');
    expect(envelope.event_type).toBe('runtime.heartbeat');
    expect(envelope.data).toMatchObject({ type: 'runtime.heartbeat', executionId: 'r-1' });
  });

  it('POST /events 缺 type/executionId → 兜底 runtime.event + 生成 event_id', async () => {
    const received: unknown[] = [];
    eventBus.subscribe('events', (e: unknown) => received.push(e));

    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const envelope = received[0] as { event_id: string; event_type: string };
    expect(envelope.event_type).toBe('runtime.event');
    expect(typeof envelope.event_id).toBe('string');
    expect(envelope.event_id.length).toBeGreaterThan(0);
  });
});
