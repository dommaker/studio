/**
 * 频道读端点鉴权回归（2026-09-14 收口）
 *
 * 契约：/api/v1/channels 全部 GET 读路由（列表/详情/消息/建议/当前PMO/文件词表）
 * 必须挂 requireAuth——匿名请求 401，与写侧对称。
 *
 * 接线：STUDIO_AUTH=on 使 requireAuth 强制模式生效（默认 none 会放行本地
 * Admin，测不出鉴权）；STUDIO_DATA_DIR 指向临时目录后才动态 import
 * channel.routes（模块级 new FileStore() 在 import 时解析数据目录）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { FileStore } from '@dommaker/studio-shared';

let tmpDir: string;
let server: Server;
let baseUrl: string;
const CH = `ch-auth-${Date.now()}`;
const OLD_STUDIO_AUTH = process.env.STUDIO_AUTH;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-auth-'));
  process.env.STUDIO_DATA_DIR = tmpDir;
  process.env.STUDIO_AUTH = 'on';
  const fileStore = new FileStore(tmpDir);
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: CH, name: '#鉴权回归', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });

  const { default: channelRoutes } = await import('../channel.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/channels', channelRoutes);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1/channels`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (OLD_STUDIO_AUTH === undefined) delete process.env.STUDIO_AUTH;
  else process.env.STUDIO_AUTH = OLD_STUDIO_AUTH;
  delete process.env.STUDIO_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('频道读端点匿名 401（STUDIO_AUTH=on）', () => {
  const READ_PATHS = [
    '',
    `/${CH}`,
    `/${CH}/messages`,
    `/${CH}/suggestions`,
    `/${CH}/current-pmo`,
    `/${CH}/file-vocabulary`,
  ];

  it.each(READ_PATHS)('GET /api/v1/channels%s 未携带 token → 401', async (suffix) => {
    const res = await fetch(`${baseUrl}${suffix}`);
    expect(res.status).toBe(401);
  });
});
