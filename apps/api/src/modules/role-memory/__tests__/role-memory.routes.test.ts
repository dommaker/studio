/**
 * role-memory.routes (#101) — 人审闸口 approve/reject 端点集成测试
 *
 * 挂载真实 router + 真实 roleMemoryStore（测试环境写 os.tmpdir()/studio-test-role-memory/<per-进程子目录>，#135），
 * 走 HTTP 验证 approve→promote（草稿→topic/索引）/ reject→demote（草稿→rejected 墓碑）。
 * STUDIO_AUTH=none（缺省）下 requireAuth/requireNotGuest 直通。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

import { roleMemoryRoot, roleMemoryStore } from '../role-memory.js';

const TEST_ROOT = roleMemoryRoot();

/** 每用例唯一角色 id，防跨用例索引/草稿状态串扰；登记入 createdRoleIds 供 afterAll 定向清理 */
const createdRoleIds: string[] = [];
function freshRoleId(): string {
  const id = `route-role-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdRoleIds.push(id);
  return id;
}

let server: Server;
let base: string;

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  const routes = (await import('../role-memory.routes.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/role-memory', routes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/role-memory`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  // #228：只清本文件用例创建的角色目录——TEST_ROOT 是跨测试文件共享根
  // （role-memory.test 等并行 worker 同用），整根 rm 会删到别人的在途数据
  for (const id of createdRoleIds) {
    fs.rmSync(path.join(TEST_ROOT, id), { recursive: true, force: true });
  }
});

describe('role-memory routes — 人审闸口 approve/reject', () => {
  it('POST /promote：草稿 → topic/索引（approve 语义）', async () => {
    const roleId = freshRoleId();
    const e = await roleMemoryStore.appendDraft(roleId, { kind: 'execution-knowledge', title: 'Route Promote', content: 'content' });
    const res = await api('POST', '/promote', { roleId, entryIds: [e.id] });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.promoted).toBe(1);
    expect(await roleMemoryStore.readDraft(roleId)).toHaveLength(0);
    expect(await roleMemoryStore.readIndex(roleId)).toContain('route-promote');
  });

  it('POST /demote：草稿 → rejected 墓碑（reject 语义，readDraft 排除）', async () => {
    const roleId = freshRoleId();
    const e = await roleMemoryStore.appendDraft(roleId, { kind: 'execution-knowledge', title: 'Route Demote', content: 'content' });
    const res = await api('POST', '/demote', { roleId, entryIds: [e.id] });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.demoted).toBe(1);
    expect(await roleMemoryStore.readDraft(roleId)).toHaveLength(0);
    // demote 不写索引
    expect(await roleMemoryStore.readIndex(roleId)).toBe('');
  });

  it('POST /promote 缺 roleId → 400', async () => {
    const res = await api('POST', '/promote', { entryIds: ['x'] });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('roleId');
  });

  it('POST /demote 空 entryIds → 400', async () => {
    const res = await api('POST', '/demote', { roleId: freshRoleId(), entryIds: [] });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('entryIds');
  });

  it('GET /draft-status：返回各条目审核状态（卡片刷新派生用）', async () => {
    const roleId = freshRoleId();
    const p = await roleMemoryStore.appendDraft(roleId, { kind: 'execution-knowledge', title: 'Status P', content: 'p' });
    const a = await roleMemoryStore.appendDraft(roleId, { kind: 'execution-knowledge', title: 'Status A', content: 'a' });
    await roleMemoryStore.promote(roleId, [a.id]);

    const res = await api('GET', `/draft-status?roleId=${roleId}&ids=${p.id},${a.id},no-such`);
    expect(res.status).toBe(200);
    expect(res.json.statuses[p.id]).toBe('pending');
    expect(res.json.statuses[a.id]).toBe('promoted');
    expect(res.json.statuses['no-such']).toBe('unknown');
  });

  it('GET /draft-status 缺 roleId → 400', async () => {
    const res = await api('GET', '/draft-status?ids=x');
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('roleId');
  });
});
