// #109（T3，#106 子票）GET / 列表「可认领」标记路由契约测试：
// 每个列表项带 claimable 布尔 —— status=unassigned 且 blockedBy 依赖全 done 才为 true。
// WorkUnitService.list 与 FileStore.getIndex 均 mock（同 workunit-evidence.routes.test.ts
// 模式：router 模块级单例指向真实 ~/.studio/data，只测路由层契约）。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockList } = vi.hoisted(() => ({
  mockList: vi.fn(),
}));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    list = mockList;
  },
}));

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

const wu = (id: string, status: string, metadata: Record<string, unknown> | null = null) => ({
  id,
  parentId: null,
  type: 'task',
  scope: `scope-${id}`,
  assigneeId: null,
  status,
  failureType: null,
  retryCount: 0,
  timeoutAt: null,
  channelId: 'ch-1',
  projectPath: null,
  workspaceId: null,
  reqId: null,
  metadata: metadata ? JSON.stringify(metadata) : null,
  createdAt: new Date(),
  updatedAt: new Date(),
  claimedAt: null,
  completedAt: null,
});

describe('GET / claimable 标记（#109）', () => {
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

  it('unassigned 无依赖 → claimable: true', async () => {
    mockList.mockResolvedValue({ data: [wu('wu-1', 'unassigned')], total: 1 });
    mockGetIndex.mockResolvedValue([{ id: 'wu-1', status: 'unassigned' }]);

    const res = await fetch(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].claimable).toBe(true);
  });

  it('unassigned 但 blockedBy 有未 done 依赖 → claimable: false；依赖 done → true', async () => {
    mockList.mockResolvedValue({
      data: [
        wu('wu-blocked', 'unassigned', { blockedBy: ['wu-dep-active'] }),
        wu('wu-ready', 'unassigned', { blockedBy: ['wu-dep-done'] }),
      ],
      total: 2,
    });
    mockGetIndex.mockResolvedValue([
      { id: 'wu-blocked', status: 'unassigned' },
      { id: 'wu-ready', status: 'unassigned' },
      { id: 'wu-dep-active', status: 'active' },
      { id: 'wu-dep-done', status: 'done' },
    ]);

    const res = await fetch(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.data.map((w: { id: string }) => [w.id, w]));
    expect(byId['wu-blocked'].claimable).toBe(false);
    expect(byId['wu-ready'].claimable).toBe(true);
  });

  it('非 unassigned → claimable: false', async () => {
    mockList.mockResolvedValue({ data: [wu('wu-1', 'active')], total: 1 });
    mockGetIndex.mockResolvedValue([{ id: 'wu-1', status: 'active' }]);

    const res = await fetch(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].claimable).toBe(false);
  });
});
