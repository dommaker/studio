/**
 * #448 问题1：channels 列表 apiCache 写后失效
 *
 * GET / 挂 30s apiCache，写操作（POST/PATCH/DELETE/PUT archive/restore）成功后
 * 必须失效列表缓存：写后立读返回新值，无写操作时缓存按 TTL 照常 HIT。
 * （STUDIO_AUTH=none 测试环境鉴权放行；数据根由 setup 隔离。）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { FileStore } from '@dommaker/studio-shared';
import channelRoutes from '../channel.routes.js';
import { clearCache } from '../../../middleware/api-cache.js';

let server: Server;
let baseUrl: string;
let fileStore: FileStore;

beforeAll(async () => {
  fileStore = new FileStore();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/channels', channelRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1/channels`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await clearCache('');
});

async function seedChannel(suffix: string): Promise<string> {
  const id = `ch-cache-${suffix}-${Date.now()}`;
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id, name: `#cache-${suffix}`, type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
  return id;
}

async function getList() {
  const res = await fetch(`${baseUrl}/`);
  const body = (await res.json()) as { data: Array<{ id: string; name: string }> };
  return { res, body };
}

describe('#448: channels 列表缓存写后失效', () => {
  it('无写操作：二次 GET 命中缓存（HIT）', async () => {
    await seedChannel('hit');
    const first = await getList();
    expect(first.res.headers.get('x-cache')).toBe('MISS');
    const second = await getList();
    expect(second.res.headers.get('x-cache')).toBe('HIT');
  });

  it('PATCH 后立读：缓存失效（MISS）且返回新值', async () => {
    const id = await seedChannel('patch');
    await getList(); // 写入缓存
    const cached = await getList();
    expect(cached.res.headers.get('x-cache')).toBe('HIT');

    const newName = `#cache-patch-renamed-${Date.now()}`;
    const patch = await fetch(`${baseUrl}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    expect(patch.status).toBe(200);

    const after = await getList();
    expect(after.res.headers.get('x-cache')).toBe('MISS');
    expect(after.body.data.some((c) => c.name === newName)).toBe(true);
  });

  it('POST 创建后立读：缓存失效（MISS）且列表含新频道', async () => {
    await getList(); // 写入缓存
    const cached = await getList();
    expect(cached.res.headers.get('x-cache')).toBe('HIT');

    const name = `cache-create-${Date.now()}`;
    const post = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(post.status).toBe(201);

    const after = await getList();
    expect(after.res.headers.get('x-cache')).toBe('MISS');
    expect(after.body.data.some((c) => c.name === `#${name}`)).toBe(true);
  });

  it('DELETE 后立读：缓存失效（MISS）且被删频道消失', async () => {
    const id = await seedChannel('delete');
    // 兜底频道：路由删除时要求存在另一个 rnd 频道
    await seedChannel('fallback');
    await getList(); // 写入缓存
    const cached = await getList();
    expect(cached.res.headers.get('x-cache')).toBe('HIT');

    const del = await fetch(`${baseUrl}/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const after = await getList();
    expect(after.res.headers.get('x-cache')).toBe('MISS');
    expect(after.body.data.some((c) => c.id === id)).toBe(false);
  });

  it('PUT archive 后立读：缓存失效（MISS）且归档频道出列表', async () => {
    const id = await seedChannel('archive');
    await getList(); // 写入缓存
    const cached = await getList();
    expect(cached.res.headers.get('x-cache')).toBe('HIT');

    const res = await fetch(`${baseUrl}/${id}/archive`, { method: 'PUT' });
    expect(res.status).toBe(200);

    const after = await getList();
    expect(after.res.headers.get('x-cache')).toBe('MISS');
    expect(after.body.data.some((c) => c.id === id)).toBe(false);
  });

  it('PATCH members 后立读：缓存失效（MISS）', async () => {
    const id = await seedChannel('members');
    await getList(); // 写入缓存
    const cached = await getList();
    expect(cached.res.headers.get('x-cache')).toBe('HIT');

    const res = await fetch(`${baseUrl}/${id}/members`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: ['agent-x'], remove: [] }),
    });
    expect(res.status).toBe(200);

    const after = await getList();
    expect(after.res.headers.get('x-cache')).toBe('MISS');
  });
});
