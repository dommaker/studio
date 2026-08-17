// companies 路由测试 — FileStore CRUD（HOME 指向 tmp 隔离真实数据）
// 风格同 deploy/webhook.routes.test.ts：挂载真实 router 起 HTTP 服务，fetch 验证。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let tmpHome: string;
let server: Server;
let base: string;
let prevHome: string | undefined;
let prevStudioHome: string | undefined;

async function req(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/v1/companies${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  // 模块加载时即计算 COMPANIES_DIR（studioPath → STUDIO_HOME 优先于 os.homedir()），
  // 须先于 import 设置 STUDIO_HOME（#219 setup 已钉隔离根，这里改指本测试的 tmp home）。
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'companies-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  prevStudioHome = process.env.STUDIO_HOME;
  process.env.STUDIO_HOME = path.join(tmpHome, '.studio');

  const { default: companyRoutes } = await import('../routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/companies', companyRoutes);

  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevStudioHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = prevStudioHome;
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('companies routes', () => {
  it('GET / 空目录返回空列表', async () => {
    const { status, json } = await req('GET', '/');
    expect(status).toBe(200);
    expect(json.data).toEqual([]);
  });

  it('POST / 创建公司并写入 FileStore', async () => {
    const { status, json } = await req('POST', '/', { name: '测试公司' });
    expect(status).toBe(201);
    expect(json.id).toMatch(/^company_/);
    expect(json.name).toBe('测试公司');

    const file = path.join(tmpHome, '.studio', 'data', 'companies', `${json.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('GET / 创建后返回公司列表', async () => {
    const { status, json } = await req('GET', '/');
    expect(status).toBe(200);
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data[0].name).toBe('测试公司');
  });

  it('GET /:companyId 返回详情，不存在返回 404', async () => {
    const created = (await req('POST', '/', { name: '详情公司' })).json;
    const found = await req('GET', `/${created.id}`);
    expect(found.status).toBe(200);
    expect(found.json.name).toBe('详情公司');

    const missing = await req('GET', '/company_not_exist');
    expect(missing.status).toBe(404);
  });

  it('PATCH /:companyId 更新名称，不存在返回 404', async () => {
    const created = (await req('POST', '/', { name: '旧名字' })).json;
    const patched = await req('PATCH', `/${created.id}`, { name: '新名字' });
    expect(patched.status).toBe(200);
    expect(patched.json.name).toBe('新名字');

    const missing = await req('PATCH', '/company_not_exist', { name: 'x' });
    expect(missing.status).toBe(404);
  });
});
