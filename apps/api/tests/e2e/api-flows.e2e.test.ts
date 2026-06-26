/**
 * E2E 业务流程测试 — 默认测试端口 13001
 */
import { describe, it, expect, beforeAll } from 'vitest';

const API = `http://localhost:${process.env.TEST_PORT || process.env.PORT || '13001'}/api/v1`;

async function api(method: string, path: string, body?: unknown) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, opts);
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 0, ok: false, error: msg, data: null };
  } finally { clearTimeout(t); }
}

describe('API Flows E2E', () => {
  beforeAll(async () => {
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch { /* not ready */ }
      await new Promise(r => setTimeout(r, 1000));
    }
  }, 30_000);

  it('health endpoint responds', async () => {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(200);
  });

  it('channels endpoint returns list', async () => {
    const res = await api('GET', '/channels');
    expect(res.status).toBe(200);
    expect(res.data?.success).toBe(true);
  });
});
