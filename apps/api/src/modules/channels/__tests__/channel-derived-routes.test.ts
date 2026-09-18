/**
 * B7/B8（2026-09-16 channel 性能审计）：频道派生读端点缓存 + 详情端点瘦身。
 *
 * B7：`GET /:id/current-pmo` 与 `GET /:id/file-vocabulary` 挂短 TTL apiCache
 *     （CACHE_CONFIG.short=5s）——两端点派生链为 N+1 全量读取，TTL 内二次请求
 *     不得再触发派生（下游派生函数调用次数作探针，X-Cache 头佐证）。
 * B8：`GET /:id` 不再附 `_count.ChannelMessage`（prisma 时代遗留形状，
 *     前端/全仓无消费方，grep `_count` 于 apps/web 零命中）——响应无该字段
 *     且不再调用 fileStore.countMessages（每请求 O(热文件行数) 全量计数）。
 *
 * 接线同 channel.routes.test.ts：STUDIO_DATA_DIR 指临时目录后动态 import
 * channel.routes（模块级 new FileStore() 在 import 时解析数据目录）；
 * auth 中间件 mock 直通；两个派生函数 mock 为计数 spy。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FileStore } from '@dommaker/studio-shared';

const { mockDeriveCurrentPmo, mockGetVocabulary } = vi.hoisted(() => ({
  mockDeriveCurrentPmo: vi.fn(async () => null),
  mockGetVocabulary: vi.fn(async () => ({ repos: [] })),
}));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: () => (_q: unknown, _s: unknown, n: () => void) => n(),
  requireNotGuest: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));

vi.mock('../current-pmo.js', () => ({
  deriveChannelCurrentPmo: mockDeriveCurrentPmo,
}));

vi.mock('../file-ref-vocabulary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../file-ref-vocabulary.js')>()),
  getChannelFileVocabulary: mockGetVocabulary,
}));

import { clearCache } from '../../../middleware/api-cache.js';

let tmpDir: string;
let server: Server;
let baseUrl: string;
const CH = `ch-derived-${Date.now()}`;
let prevDataDir: string | undefined;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-derived-routes-'));
  prevDataDir = process.env.STUDIO_DATA_DIR;
  process.env.STUDIO_DATA_DIR = tmpDir;
  const fileStore = new FileStore(tmpDir);
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: CH, name: '#derived-cache', type: 'rnd',
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
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/channels`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (prevDataDir === undefined) delete process.env.STUDIO_DATA_DIR;
  else process.env.STUDIO_DATA_DIR = prevDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearCache('');
});

describe('B7：派生读端点短 TTL apiCache', () => {
  it('GET /:id/current-pmo —— TTL 内二次请求 HIT，派生仅一次', async () => {
    const res1 = await fetch(`${baseUrl}/${CH}/current-pmo`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-cache')).toBe('MISS');
    expect(mockDeriveCurrentPmo).toHaveBeenCalledTimes(1);

    const res2 = await fetch(`${baseUrl}/${CH}/current-pmo`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-cache')).toBe('HIT');
    expect(mockDeriveCurrentPmo).toHaveBeenCalledTimes(1);
  });

  it('GET /:id/file-vocabulary —— TTL 内二次请求 HIT，词表派生仅一次', async () => {
    const res1 = await fetch(`${baseUrl}/${CH}/file-vocabulary`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-cache')).toBe('MISS');
    expect(mockGetVocabulary).toHaveBeenCalledTimes(1);

    const res2 = await fetch(`${baseUrl}/${CH}/file-vocabulary`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-cache')).toBe('HIT');
    expect(mockGetVocabulary).toHaveBeenCalledTimes(1);
  });
});

describe('B8：GET /:id 不再全量 countMessages', () => {
  it('响应无 prisma 遗留 _count 字段，且不调用 fileStore.countMessages', async () => {
    const countSpy = vi.spyOn(FileStore.prototype, 'countMessages');
    try {
      const res = await fetch(`${baseUrl}/${CH}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: Record<string, unknown> };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(CH);
      expect(body.data._count).toBeUndefined();
      expect(countSpy).not.toHaveBeenCalled();
    } finally {
      countSpy.mockRestore();
    }
  });
});
