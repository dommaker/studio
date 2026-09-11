/**
 * 频道图片附件端点测试（2026-09，「频道里加上截图」）
 *
 * 覆盖：上传成功（201 + 文件落盘 + 取图 200/Content-Type）、类型拒绝 400、
 *       超限 413、未认证 401（STUDIO_AUTH 临时翻 on）、非法 id 400、不存在 404。
 *
 * 接线：STUDIO_DATA_DIR 指向临时目录后才动态 import channel.routes
 * （模块级 `new FileStore()` 在 import 时解析数据目录）。
 * 测试 app 不挂全局 json——路由级 `json({ limit: '8mb' })` 自足（生产由 app.ts 同路径预解析）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { FileStore } from '@dommaker/studio-shared';

let tmpDir: string;
let server: Server;
let baseUrl: string;

const CH = `ch-attach-${Date.now()}`;
// 1x1 PNG（合法图片字节）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-attach-'));
  process.env.STUDIO_DATA_DIR = tmpDir;

  const { default: channelRoutes } = await import('../channel.routes.js');
  const app = express();
  app.use('/api/v1/channels', channelRoutes);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1/channels`;

  const fileStore = new FileStore(tmpDir);
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: CH, name: '#附件', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  delete process.env.STUDIO_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 401 用例临时翻开认证，完事还原（vitest config 默认 STUDIO_AUTH=none 放行）
afterEach(() => {
  process.env.STUDIO_AUTH = 'none';
});

async function upload(body: unknown, channelId = CH) {
  return fetch(`${baseUrl}/${channelId}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /channels/:id/attachments', () => {
  it('上传成功 → 201 {id,url}，文件落盘数据区', async () => {
    const res = await upload({ mime: 'image/png', dataBase64: PNG_BYTES.toString('base64') });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(body.data.url).toBe(`/api/v1/channels/${CH}/attachments/${body.data.id}`);
    expect(body.data.size).toBe(PNG_BYTES.length);
    const onDisk = path.join(tmpDir, 'attachments', CH, body.data.id);
    expect(fs.readFileSync(onDisk).equals(PNG_BYTES)).toBe(true);
  });

  it('mime 不在白名单 → 400', async () => {
    const res = await upload({ mime: 'image/bmp', dataBase64: PNG_BYTES.toString('base64') });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('图片类型');
  });

  it('缺 dataBase64 → 400', async () => {
    const res = await upload({ mime: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('超过 5MB → 413', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString('base64');
    const res = await upload({ mime: 'image/png', dataBase64: big });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('5MB');
  });

  it('未认证（STUDIO_AUTH=on 无 token）→ 401', async () => {
    process.env.STUDIO_AUTH = 'on';
    const res = await upload({ mime: 'image/png', dataBase64: PNG_BYTES.toString('base64') });
    expect(res.status).toBe(401);
  });

  it('频道不存在 → 404', async () => {
    const res = await upload({ mime: 'image/png', dataBase64: PNG_BYTES.toString('base64') }, 'ch-nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('GET /channels/:id/attachments/:attachmentId', () => {
  it('取图 200 + 正确 Content-Type + 字节一致', async () => {
    const up = await upload({ mime: 'image/png', dataBase64: PNG_BYTES.toString('base64') });
    const { data } = await up.json();
    const res = await fetch(`${baseUrl}/${CH}/attachments/${data.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(PNG_BYTES)).toBe(true);
  });

  it('非法 id（路径穿越形态）→ 400', async () => {
    expect((await fetch(`${baseUrl}/${CH}/attachments/..%2F..%2Fetc`)).status).not.toBe(200);
    expect((await fetch(`${baseUrl}/${CH}/attachments/not-an-id`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/${CH}/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.exe`)).status).toBe(400);
  });

  it('合法形态但不存在 → 404', async () => {
    const res = await fetch(`${baseUrl}/${CH}/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png`);
    expect(res.status).toBe(404);
  });

  it('未认证（STUDIO_AUTH=on，无 token / 无效 ?token=）→ 401', async () => {
    process.env.STUDIO_AUTH = 'on';
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';
    expect((await fetch(`${baseUrl}/${CH}/attachments/${id}`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/${CH}/attachments/${id}?token=bogus`)).status).toBe(401);
  });
});
