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

/** GET /:id/messages 响应体（{ data: { messages, total, hasMore } }；messages 内 meta 已 JSON.parse、createdAt 经 JSON 序列化回字符串） */
interface MessagesPageResponse {
  data: {
    messages: Array<Omit<ChannelMessageData, 'meta' | 'createdAt'> & { meta: unknown; createdAt: string }>;
    total: number;
    hasMore: boolean;
  };
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

  const { channelReadRoutes, channelWriteRoutes, channelAttachmentRoutes } = await import('../channel.routes.js');
  const { requireAuth, requireNotGuest } = await import('../../../middleware/auth.js');
  const app = express();
  app.use(express.json());
  // P2-e：镜像 route-registry 挂载姿态（attachment 先挂 + read 挂 requireAuth + write 挂 authNotGuest）
  app.use('/api/v1/channels', channelAttachmentRoutes, requireAuth(), channelReadRoutes, requireNotGuest(), channelWriteRoutes);
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
    // #525 P2-4：total 默认不统计（total 恒 0），要总数显式 includeTotal=true
    const res = await fetch(`${baseUrl}/${CH}/messages?limit=3&includeTotal=true`);
    const body: MessagesPageResponse = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.messages).toHaveLength(3);
    expect(body.data.total).toBe(MSG_COUNT);
    expect(body.data.hasMore).toBe(true);
    // 最新 3 条，页内升序
    expect(body.data.messages.map(m => m.id)).toEqual(['msg-07', 'msg-08', 'msg-09']);
  });

  it('limit 大于消息总数时返回全部，hasMore=false', async () => {
    const res = await fetch(`${baseUrl}/${CH}/messages?limit=50`);
    const body: MessagesPageResponse = await res.json();

    expect(body.data.messages).toHaveLength(MSG_COUNT);
    expect(body.data.hasMore).toBe(false);
  });

  // #264：meta 形态契约——REST 出口必须是 object（前端 NotificationBell/频道页按 object 定型消费），
  // 防有人把 shapeMessageData 改回 string 造成二次错配（人审卡全灭事故的回归点）
  it('契约：data 内 meta 为 object（非 string），卡片 meta 完整解析', async () => {
    const cardMeta = { cardType: 'knowledge_proposal', status: 'ready', cardData: { entries: [{ id: 'k-1' }] } };
    await fileStore.appendMessage(CH, {
      id: 'msg-card',
      channelId: CH,
      workUnitId: null,
      authorType: 'agent',
      agentName: 'librarian',
      content: '知识提案 — 待人工审核',
      replyToId: null,
      meta: JSON.stringify(cardMeta),
      createdAt: new Date().toISOString(),
    });

    const res = await fetch(`${baseUrl}/${CH}/messages?limit=50`);
    const body: MessagesPageResponse = await res.json();

    for (const m of body.data.messages) {
      expect(typeof m.meta).toBe('object');
      expect(m.meta).not.toBeNull();
      expect(Array.isArray(m.meta)).toBe(false);
    }
    const card = body.data.messages.find(m => m.id === 'msg-card');
    expect(card?.meta).toEqual(cardMeta);
  });

  it('before=<messageId> + limit 组合：锚点前窗口内取最新 take 条（#319 id 游标）', async () => {
    const res = await fetch(`${baseUrl}/${CH}/messages?limit=2&before=msg-05&includeTotal=true`);
    const body: MessagesPageResponse = await res.json();

    expect(body.data.total).toBe(11); // 候选 8 统一口径：热+冷原始行数（原「锚点过滤后的总数」随分支漂移，退役）
    expect(body.data.messages).toHaveLength(2);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.messages.map(m => m.id)).toEqual(['msg-03', 'msg-04']);
  });

  it('锚点 id 不存在 → 空页、hasMore=false（#319：位置不可知不整页错发）', async () => {
    const res = await fetch(`${baseUrl}/${CH}/messages?limit=2&before=msg-gone`);
    const body: MessagesPageResponse = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.messages).toEqual([]);
    expect(body.data.hasMore).toBe(false);
  });
});
