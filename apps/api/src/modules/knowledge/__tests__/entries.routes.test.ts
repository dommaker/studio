/**
 * entries.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 挂载 entriesRoutes 到 express app，覆盖：
 * POST /unified（400 缺字段 / 201 创建，applicableAgents → agent: 标签）、
 * GET /unified（列出创建的条目）、POST /ask（400 / 空库短路回答，不触发 LLM）、
 * GET /gaps/:type（非法类型 400）、GET /export（md / json 两种格式）。
 * HOME 指向临时目录隔离 sharedStore（~/.studio/knowledge）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let server: Server;
let base: string;

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-entries-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { entriesRoutes } = await import('../entries.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/knowledge', entriesRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/knowledge`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('entries.routes', () => {
  it('POST /unified 400 when required fields missing', async () => {
    const res = await api('POST', '/unified', { type: 'guideline', title: 'T' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('Missing required fields');
  });

  it('POST /unified 201 creates entry, applicableAgents stored as agent: tags', async () => {
    const res = await api('POST', '/unified', {
      type: 'guideline', title: '提交规范', content: '约定式提交',
      consumptionMode: 'reference', applicableAgents: ['executor'], tags: ['process'],
    });
    expect(res.status).toBe(201);
    expect(res.json.id).toMatch(/^manual-/);
    expect(res.json.title).toBe('提交规范');
    expect(res.json.consumptionMode).toBe('reference');
  });

  it('GET /unified lists created entry (agent: tag preserved)', async () => {
    const res = await api('GET', '/unified');
    expect(res.status).toBe(200);
    const entries = res.json.entries ?? res.json;
    const found = (Array.isArray(entries) ? entries : []).find((e: any) => e.title === '提交规范');
    expect(found).toBeTruthy();
    expect(found.tags).toContain('agent:executor');
    expect(found.tags).toContain('process');
  });

  it('POST /ask 400 without question', async () => {
    const res = await api('POST', '/ask', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('question is required');
  });

  it('POST /ask short-circuits when no entry matches (no LLM call)', async () => {
    const res = await api('POST', '/ask', { question: 'zzz-no-match-token' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ answer: '未找到相关知识条目。', sources: [] });
  });

  it('GET /gaps/:type 400 for invalid type', async () => {
    const res = await api('GET', '/gaps/bogus');
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('Invalid type');
  });

  it('GET /export returns markdown by default and JSON with format=json', async () => {
    const md = await api('GET', '/export');
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.headers.get('content-disposition')).toContain('knowledge-export.md');

    const jsonRes = await fetch(`${base}/export?format=json`);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('content-type')).toContain('application/json');
    const entries = await jsonRes.json() as any[];
    expect(entries.some((e: any) => e.title === '提交规范')).toBe(true);
  });
});
