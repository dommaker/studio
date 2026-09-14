// #529 GET /workunits/:id/messages 频道归属解析契约：
// 从 WU 一等列 channelId 解析归属后传给 listByWorkUnitId（与写侧 POST /:id/messages
// 同字段，读写对称）；wu.channelId == null（legacy/手工单）传 undefined → 服务层扇出
// fallback。只测路由层契约（同 workunit-claimable.routes.test.ts 模式）。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockGetById } = vi.hoisted(() => ({ mockGetById: vi.fn() }));
const { mockListByWu } = vi.hoisted(() => ({ mockListByWu: vi.fn() }));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    getById = mockGetById;
  },
}));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { listByWorkUnitId: mockListByWu },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    FileStore: class {},
  };
});

import router from '../workunit.routes.js';

/** WorkUnitData 最小形状（仅 GET /:id/messages 消费的字段） */
const wu = (id: string, channelId: string | null) => ({
  id,
  parentId: null,
  type: 'task',
  scope: `scope-${id}`,
  assigneeId: null,
  status: 'active',
  failureType: null,
  retryCount: 0,
  timeoutAt: null,
  channelId,
  projectPath: null,
  workspaceId: null,
  reqId: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  claimedAt: null,
  completedAt: null,
});

describe('GET /:id/messages 频道归属解析（#529）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/workunits', router);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}/workunits`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockListByWu.mockResolvedValue({ data: [], total: 0 });
  });

  it('WU 带 channelId → 传入直查（与写侧 POST 同字段）', async () => {
    mockGetById.mockResolvedValue(wu('wu-1', 'ch-A'));

    const res = await fetch(`${base}/wu-1/messages`);
    expect(res.status).toBe(200);

    expect(mockListByWu).toHaveBeenCalledTimes(1);
    const [wuId, opts] = mockListByWu.mock.calls[0];
    expect(wuId).toBe('wu-1');
    expect(opts.channelId).toBe('ch-A');
  });

  it('WU 无 channelId（legacy 手工单）→ 传 undefined 走扇出 fallback', async () => {
    mockGetById.mockResolvedValue(wu('wu-2', null));

    const res = await fetch(`${base}/wu-2/messages`);
    expect(res.status).toBe(200);

    const [, opts] = mockListByWu.mock.calls[0];
    expect(opts.channelId).toBeUndefined();
  });

  it('WU 不存在 → 不抛错，channelId 缺省走 fallback（行为与改造前一致）', async () => {
    mockGetById.mockResolvedValue(null);

    const res = await fetch(`${base}/wu-none/messages`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    const [wuId, opts] = mockListByWu.mock.calls[0];
    expect(wuId).toBe('wu-none');
    expect(opts.channelId).toBeUndefined();
  });
});
