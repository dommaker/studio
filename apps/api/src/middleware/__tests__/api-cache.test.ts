/**
 * api-cache 中间件单测 — #403 补：错误响应（≥400）不缓存。
 * 瞬时失败（下游 500/404）不得在 TTL 窗口内钉死端点；2xx 照常 HIT。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { apiCache, clearCache, sweepExpired } from '../api-cache.js';

let server: { close(): void } | null = null;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  app.get('/ok', apiCache(60), (_req, res) => { res.json({ ok: true }); });
  app.get('/err', apiCache(60), (_req, res) => { res.status(500).json({ error: 'boom' }); });
  app.get('/short', apiCache(0.05), (_req, res) => { res.json({ short: true }); });
  await new Promise<void>((resolve) => {
    const s = app.listen(0, () => { server = s; resolve(); });
  });
  const addr = (server as unknown as { address(): { port: number } }).address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => { server?.close(); });

beforeEach(async () => { await clearCache(''); });

describe('apiCache 错误响应不缓存（#403）', () => {
  it('2xx：首请求 MISS，二次请求 HIT（命中缓存不再到 handler）', async () => {
    const res1 = await fetch(`${baseUrl}/ok`);
    expect(res1.headers.get('x-cache')).toBe('MISS');
    const res2 = await fetch(`${baseUrl}/ok`);
    expect(res2.headers.get('x-cache')).toBe('HIT');
    expect(await res2.json()).toEqual({ ok: true });
  });

  it('500：连续两次都 MISS（错误响应不写入缓存）', async () => {
    const res1 = await fetch(`${baseUrl}/err`);
    expect(res1.status).toBe(500);
    expect(res1.headers.get('x-cache')).toBe('MISS');
    const res2 = await fetch(`${baseUrl}/err`);
    expect(res2.status).toBe(500);
    expect(res2.headers.get('x-cache')).toBe('MISS');
  });
});

describe('apiCache 过期键惰性清扫（B6）', () => {
  it('任意写入触发清扫：过期键被移除，不再滞留 Map', async () => {
    await fetch(`${baseUrl}/short`);                          // 50ms TTL 写入
    await new Promise(r => setTimeout(r, 80));                // 等过期
    await fetch(`${baseUrl}/ok`);                             // 新写入触发惰性清扫
    expect(sweepExpired()).toBe(0);                           // 过期键已清（未清扫则此处 = 1）
    const res = await fetch(`${baseUrl}/short`);
    expect(res.headers.get('x-cache')).toBe('MISS');          // 过期不 HIT
  });
});
