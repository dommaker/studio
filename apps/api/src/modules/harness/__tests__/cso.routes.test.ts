/**
 * cso.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（CSOValidator 类，记录构造次数），挂载 csoRoutes 于
 * /api/v1/cso（与 route-registry.ts 一致）覆盖：GET /validate。
 * HOME 指向临时目录隔离 knowledge-bus 链路。
 *
 * harness 3.0.0（ADR-0041）：CSOValidator.getInstance() 单例壳出清 → 路由改直建
 * `new CSOValidator()`。本测试必须断言构造函数真的被调用——原可选链写法
 * （CSOValidator?.getInstance?.()）在符号消失时会静默落「not available」假绿分支，
 * TS 编译与构建都拦不住，只有走到真实构造才算数。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { csoBuilt } = vi.hoisted(() => ({ csoBuilt: { count: 0 } }));

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return {
    ...actual,
    CSOValidator: class {
      constructor() {
        csoBuilt.count++;
      }
      validateWorkflow() {
        return { valid: true };
      }
    },
  };
});

let tmpHome: string;
let prevHome: string | undefined;
let server: Server;
let base: string;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cso-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const { csoRoutes } = await import('../cso.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/cso', csoRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/cso`;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('cso.routes', () => {
  it('GET /validate returns valid response when validator available', async () => {
    const before = csoBuilt.count;
    const res = await fetch(`${base}/validate`);
    expect(res.status).toBe(200);
    // { valid, issues } 进 { data } 壳（批次 6/7）
    expect(await res.json()).toEqual({ data: { valid: true, issues: [] } });
    // harness 3.0.0 直建分支真实走到（去假绿断言：构造计数器必须递增）
    expect(csoBuilt.count).toBe(before + 1);
  });
});
