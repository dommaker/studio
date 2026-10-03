/**
 * #632: 发送前归属预览端点 + defaultProfileId 退役的入口收口
 *
 * - GET /:id/merge-target：只读预测无 @ 无 replyTo 消息的归属，
 *   与 routeMessage 共用 resolveMergeTarget 判定（预览 = 实际路由）
 *   返回 { status: 'unique' | 'ambiguous' | 'none', workUnit?: { id, title } }
 * - PATCH /:id 不再接受 defaultProfileId（字段已退役 → 400）
 * - POST /:id/messages 新增 intent（new-task / plain），非法值 400
 *
 * 接线同 channel.routes.test.ts：STUDIO_DATA_DIR 指临时目录后动态 import
 * channel.routes（模块级 new FileStore() 在 import 时解析数据目录）；auth 中间件 mock 直通。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../../workunit/workunit.service.js';

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: () => (_q: unknown, _s: unknown, n: () => void) => n(),
  requireNotGuest: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));

let tmpDir: string;
let server: Server;
let baseUrl: string;
let fileStore: FileStore;
let workUnitService: WorkUnitService;
let seq = 0;

async function seedChannel(): Promise<string> {
  const id = `ch-mt-${Date.now()}-${++seq}`;
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id, name: `#${id}`, type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
  return id;
}

async function seedInFlight(channelId: string, scope: string): Promise<string> {
  const wu = await workUnitService.create({
    scope, channelId, type: 'task', status: 'active', assigneeId: 'instance-1',
  });
  await fileStore.appendMessage(channelId, {
    id: `m-${wu.id}`, channelId, authorType: 'human', agentName: null,
    content: '在聊这个', replyToId: null, meta: '{}', workUnitId: wu.id,
    createdAt: new Date().toISOString(),
  });
  return wu.id;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-merge-target-'));
  process.env.STUDIO_DATA_DIR = tmpDir;

  const { channelReadRoutes, channelWriteRoutes, channelAttachmentRoutes } = await import('../channel.routes.js');
  const { requireAuth, requireNotGuest } = await import('../../../middleware/auth.js');
  const app = express();
  app.use(express.json());
  // P2-e：镜像 route-registry 挂载姿态（attachment 先挂 + read 挂 requireAuth + write 挂 authNotGuest）
  app.use('/api/v1/channels', channelAttachmentRoutes, requireAuth(), channelReadRoutes, requireNotGuest(), channelWriteRoutes);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1/channels`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  delete process.env.STUDIO_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fileStore = new FileStore(tmpDir);
  workUnitService = new WorkUnitService(fileStore);
});

describe('#632: GET /:id/merge-target 发送前归属预览', () => {
  it('无合并目标 → status=none', async () => {
    const channelId = await seedChannel();
    const res = await fetch(`${baseUrl}/${channelId}/merge-target`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ status: 'none' });
  });

  it('唯一在途合并目标 → status=unique + workUnit{id,title}', async () => {
    const channelId = await seedChannel();
    const wuId = await seedInFlight(channelId, '唯一在途任务标题');

    const res = await fetch(`${baseUrl}/${channelId}/merge-target`);
    const body = await res.json();
    expect(body.data.status).toBe('unique');
    expect(body.data.workUnit).toEqual({ id: wuId, title: '唯一在途任务标题' });
  });

  it('窗口内 ≥2 个不同在途 WU → status=ambiguous（不暴露并入目标）', async () => {
    const channelId = await seedChannel();
    await seedInFlight(channelId, '任务 A');
    await seedInFlight(channelId, '任务 B');

    const res = await fetch(`${baseUrl}/${channelId}/merge-target`);
    const body = await res.json();
    expect(body.data).toEqual({ status: 'ambiguous' });
  });

  it('预览与实际路由一致：unique 时发消息并入同一 WU', async () => {
    const channelId = await seedChannel();
    const wuId = await seedInFlight(channelId, '一致性任务');

    const preview = await (await fetch(`${baseUrl}/${channelId}/merge-target`)).json();
    const res = await fetch(`${baseUrl}/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '补充信息' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.workUnitId).toBe(wuId);
    expect(preview.data.workUnit.id).toBe(body.data.workUnitId);
  });

  it('预览与实际路由一致：ambiguous 时发消息落纯存储', async () => {
    const channelId = await seedChannel();
    await seedInFlight(channelId, '任务 A');
    await seedInFlight(channelId, '任务 B');

    const res = await fetch(`${baseUrl}/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '说不清归属' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.workUnitId).toBeNull();
  });
});

describe('#632: POST /:id/messages intent', () => {
  it('intent=new-task → 建未指派 WU 并关联消息', async () => {
    const channelId = await seedChannel();
    await seedInFlight(channelId, '在途任务');

    const res = await fetch(`${baseUrl}/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '这是一件新事', intent: 'new-task' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.workUnitId).toBeTruthy();
    const snap = (await fileStore.getIndex()).find(s => s.id === body.data.workUnitId);
    expect(snap!.status).toBe('unassigned');
    expect(snap!.assigneeId).toBeNull();
  });

  it('intent=plain → 纯存储', async () => {
    const channelId = await seedChannel();
    await seedInFlight(channelId, '在途任务');

    const res = await fetch(`${baseUrl}/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '纯闲聊', intent: 'plain' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.workUnitId).toBeNull();
  });

  it('非法 intent → 400', async () => {
    const channelId = await seedChannel();
    const res = await fetch(`${baseUrl}/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi', intent: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('#632: PATCH /:id 退役 defaultProfileId', () => {
  it('携带 defaultProfileId → 400（字段已退役）', async () => {
    const channelId = await seedChannel();
    const res = await fetch(`${baseUrl}/${channelId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultProfileId: null }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('defaultProfileId');
  });

  it('正常字段（name）不受影响', async () => {
    const channelId = await seedChannel();
    const res = await fetch(`${baseUrl}/${channelId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '#改名后' }),
    });
    expect(res.status).toBe(200);
  });
});
