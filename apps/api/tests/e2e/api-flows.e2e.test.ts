/**
 * E2E 业务流程测试 — 默认测试端口 13001
 */
import { describe, it, expect, beforeAll } from 'vitest';

const API = `http://localhost:${process.env.TEST_PORT || '13001'}/api/v1`;

async function api(method: string, path: string, body?: any) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const opts: any = { method, headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, opts);
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  } catch (e: any) {
    return { status: 0, ok: false, error: e.message };
  } finally { clearTimeout(t); }
}
const get = (p: string) => api('GET', p);
const post = (p: string, b?: any) => api('POST', p, b);




