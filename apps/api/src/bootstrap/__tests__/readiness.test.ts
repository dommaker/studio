/**
 * readiness（/readyz）测试（2026-10-03 根因修复 B 批）：
 * - readiness 状态机：初始未就绪 → markReady 后就绪（幂等，首戳时间不变）；
 * - /readyz 端点：未就绪 503 {status:'starting'} → markReady 后 200 {status:'ready'}；
 *   /health（liveness）不受 readiness 影响恒 200。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'http';
import { app } from '../../app.js';
import { markReady, isReady, readyTimestamp, resetReadiness } from '../readiness.js';

describe('readiness 状态机', () => {
  beforeEach(() => resetReadiness());
  afterEach(() => resetReadiness());

  it('初始未就绪；markReady 后就绪且带时间戳', () => {
    expect(isReady()).toBe(false);
    expect(readyTimestamp()).toBeNull();
    markReady();
    expect(isReady()).toBe(true);
    expect(readyTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('markReady 幂等：重复调用不覆盖首戳时间', () => {
    markReady();
    const first = readyTimestamp();
    markReady();
    expect(readyTimestamp()).toBe(first);
  });
});

describe('/readyz 端点', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    resetReadiness();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    resetReadiness();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('未就绪 → 503 {status:"starting"}；/health 不受影响恒 200', async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'starting' });

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  it('markReady 后 → 200 {status:"ready", timestamp}', async () => {
    markReady();
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.timestamp).toBe(readyTimestamp());
  });
});
