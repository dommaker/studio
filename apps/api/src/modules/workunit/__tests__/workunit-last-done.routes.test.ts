// #387 GET /last-done 路由契约 + 聚合口径测试：
// 每 assignee 取最近一条 done/completed WU（completedAt ?? updatedAt 降序取首条），
// 消 roster 空闲卡逐实例 GET /workunits?assigneeId= 的 N+1。
// FileStore.getIndex mock（同 workunit-claimable.routes.test.ts 模式：router 模块级
// 单例指向 mock 索引，Service 走真实实现——聚合口径就是被测对象）。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockGetIndex } = vi.hoisted(() => ({
  mockGetIndex: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    FileStore: class {
      getIndex = mockGetIndex;
    },
  };
});

import router from '../workunit.routes.js';

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  id: 'wu-x',
  parentId: null,
  type: 'task',
  scope: 'scope-x',
  assigneeId: null,
  status: 'done',
  failureType: null,
  retryCount: 0,
  timeoutAt: null,
  channelId: 'ch-1',
  projectPath: null,
  workspaceId: null,
  reqId: null,
  metadata: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  claimedAt: null,
  completedAt: null,
  ...overrides,
});

describe('GET /last-done（#387 批量最近完成）', () => {
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
  });

  it('多 assignee 各取最近完成：completedAt 新者优先，缺失回落 updatedAt', async () => {
    mockGetIndex.mockResolvedValue([
      snapshot({ id: 'wu-1', assigneeId: 'a1', status: 'done', completedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }),
      snapshot({ id: 'wu-2', assigneeId: 'a1', status: 'done', completedAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z' }),
      // 无 completedAt 的 done：与 a2 比较走 updatedAt 回落
      snapshot({ id: 'wu-3', assigneeId: 'a2', status: 'done', completedAt: null, updatedAt: '2026-08-05T00:00:00.000Z' }),
      snapshot({ id: 'wu-4', assigneeId: 'a2', status: 'completed', completedAt: null, updatedAt: '2026-08-09T00:00:00.000Z' }),
    ]);

    const res = await fetch(`${base}/last-done?assigneeIds=a1,a2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.a1.id).toBe('wu-2');
    expect(body.data.a2.id).toBe('wu-4');
  });

  it('非完成状态不入选；无完成记录的 assignee → null', async () => {
    mockGetIndex.mockResolvedValue([
      snapshot({ id: 'wu-5', assigneeId: 'a1', status: 'active', updatedAt: '2026-08-10T00:00:00.000Z' }),
      snapshot({ id: 'wu-6', assigneeId: 'a1', status: 'in_review', updatedAt: '2026-08-09T00:00:00.000Z' }),
    ]);

    const res = await fetch(`${base}/last-done?assigneeIds=a1,a3`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.a1).toBeNull();
    expect(body.data.a3).toBeNull();
  });

  it('缺 assigneeIds / 空值 → 400', async () => {
    const missing = await fetch(`${base}/last-done`);
    expect(missing.status).toBe(400);
    const blank = await fetch(`${base}/last-done?assigneeIds=, ,`);
    expect(blank.status).toBe(400);
  });
});
