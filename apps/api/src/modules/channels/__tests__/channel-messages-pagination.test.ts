/**
 * C2: GET /api/v1/channels/:id/messages 分页 limit 回归测试
 *
 * 回归：此前路由只在 hasMore 时 pop() 一条，从未 slice(0, take)，
 * limit 白设、全量消息返回。修复后只返回最新 take 条（升序）。
 *
 * 接线：STUDIO_DATA_DIR 指向临时目录后才动态 import channel.routes
 * （模块级 `new FileStore()` 在 import 时解析数据目录）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';

/** GET /:id/messages 响应体（data 内 meta 已 JSON.parse、createdAt 经 JSON 序列化回字符串） */
interface MessagesPageResponse {
  success: boolean;
  data: Array<Omit<ChannelMessageData, 'meta' | 'createdAt'> & { meta: unknown; createdAt: string }>;
  total: number;
  hasMore: boolean;
}

let tmpDir: string;
let fileStore: FileStore;
let server: Server;
let baseUrl: string;

const CH = `ch-limit-${Date.now()}`;
const MSG_COUNT = 10;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-limit-'));
  process.env.STUDIO_DATA_DIR = tmpDir;
  fileStore = new FileStore(tmpDir);

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

  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: CH, name: '#分页', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
  // 10 条消息，createdAt 逐条递增 1s
  for (let i = 0; i < MSG_COUNT; i++) {
    await fileStore.appendMessage(CH, {
      id: `msg-${String(i).padStart(2, '0')}`,
      channelId: CH,
      workUnitId: null,
      authorType: 'human',
      agentName: null,
      content: `message ${i}`,
      replyToId: null,
      meta: '{}',
      createdAt: new Date(Date.now() - (MSG_COUNT - i) * 1000).toISOString(),
    });
  }
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  delete process.env.STUDIO_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /channels/:id/messages 分页 limit（C2）', () => {
  it('limit=3 只返回最新 3 条（升序），hasMore=true，total 为全量', async () => {
    const res = await fetch(`${baseUrl}/${CH}/messages?limit=3`);
    const body: MessagesPageResponse = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(3);
    expect(body.total).toBe(MSG_COUNT);
    expect(body.hasMore).toBe(true);
    // 最新 3 条，页内升序
    expect(body.data.map(m => m.id)).toEqual(['msg-07', 'msg-08', 'msg-09']);
  });

  it('limit 大于消息总数时返回全部，hasMore=false', async () => {
    const res = await fetch(`${baseUrl}/${CH}/messages?limit=50`);
    const body: MessagesPageResponse = await res.json();

    expect(body.data).toHaveLength(MSG_COUNT);
    expect(body.hasMore).toBe(false);
  });

  it('before + limit 组合：窗口内仍只取最新 take 条', async () => {
    const before = new Date(Date.now() - 5.5 * 1000).toISOString(); // 只含 msg-00..msg-04
    const res = await fetch(`${baseUrl}/${CH}/messages?limit=2&before=${encodeURIComponent(before)}`);
    const body: MessagesPageResponse = await res.json();

    expect(body.total).toBe(5);
    expect(body.data).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(body.data.map(m => m.id)).toEqual(['msg-03', 'msg-04']);
  });
});
