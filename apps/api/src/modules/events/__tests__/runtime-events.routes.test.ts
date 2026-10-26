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
import { issueAgentServiceIdentity } from '@dommaker/studio-shared/node';
import { requireAuth, agentServiceEndpointAllowlist } from '../../../middleware/auth.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const { default: router } = await import('../runtime-events.routes.js');
  const app = express();
  app.use(express.json());
  app.use(agentServiceEndpointAllowlist());
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

  it('SEC-05：无效 Agent 身份回调被拒绝，且不发布任何状态事件', async () => {
    const received: unknown[] = [];
    eventBus.subscribe('events', (e: unknown) => received.push(e));
    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sta_invalid_sec05' },
      body: JSON.stringify({ type: 'runtime.heartbeat', executionId: 'forbidden' }),
    });
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('SEC-05：有效 Agent 服务身份只允许回调，不能进入免登录 Operator 控制面', async () => {
    const { token, brokerMarker } = issueAgentServiceIdentity({ executionId: 'exec-sec05', ttlMs: 60_000 });
    const received: unknown[] = [];
    eventBus.subscribe('events', (e: unknown) => received.push(e));
    const callback = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-studio-agent-broker': brokerMarker },
      body: JSON.stringify({ type: 'runtime.heartbeat', executionId: 'exec-sec05' }),
    });
    expect(callback.status).toBe(200);
    expect(received).toHaveLength(1);
    const missingMarker = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'runtime.heartbeat', executionId: 'exec-sec05' }),
    });
    expect(missingMarker.status).toBe(403);
    expect(received).toHaveLength(1);
    const wrongExecution = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-studio-agent-broker': brokerMarker },
      body: JSON.stringify({ type: 'runtime.heartbeat', executionId: 'another-execution' }),
    });
    expect(wrongExecution.status).toBe(403);
    expect(received).toHaveLength(1);
    for (const body of [{}, { executionId: 123 }]) {
      const invalid = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-studio-agent-broker': brokerMarker },
        body: JSON.stringify({ type: 'runtime.heartbeat', ...body }),
      });
      expect(invalid.status).toBe(403);
      expect(received).toHaveLength(1);
    }
    for (const authorization of [undefined, 'Bearer fake-operator-token-sec05']) {
      const unauthenticated = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-studio-agent-broker': brokerMarker, ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify({ type: 'runtime.heartbeat', executionId: 'exec-sec05' }),
      });
      expect(unauthenticated.status).toBe(403);
      expect(received).toHaveLength(1);
    }

    let operatorSideEffects = 0;
    const app = express();
    app.post('/operator-only', requireAuth(), (_req, res) => {
      operatorSideEffects += 1;
      res.json({ data: { changed: true } });
    });
    const operatorServer = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => operatorServer.once('listening', resolve));
    const previousAuth = process.env.STUDIO_AUTH;
    process.env.STUDIO_AUTH = 'none';
    try {
      const port = (operatorServer.address() as AddressInfo).port;
      const denied = await fetch(`http://127.0.0.1:${port}/operator-only`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      expect(denied.status).toBe(403);
      expect(operatorSideEffects).toBe(0);
      for (const authorization of [undefined, 'Bearer fake-operator-token-sec05']) {
        const brokerRequest = await fetch(`http://127.0.0.1:${port}/operator-only`, {
          method: 'POST',
          headers: { 'x-studio-agent-broker': brokerMarker, ...(authorization ? { Authorization: authorization } : {}) },
        });
        expect(brokerRequest.status).toBe(403);
        expect(operatorSideEffects).toBe(0);
      }
      const ordinaryOperator = await fetch(`http://127.0.0.1:${port}/operator-only`, { method: 'POST' });
      expect(ordinaryOperator.status).toBe(200);
      expect(operatorSideEffects).toBe(1);
    } finally {
      if (previousAuth === undefined) delete process.env.STUDIO_AUTH;
      else process.env.STUDIO_AUTH = previousAuth;
      await new Promise<void>(resolve => operatorServer.close(() => resolve()));
    }
  });
});
