// #456：GET /workunits?projectId= 路由契约测试 —— 查询参数正确透传到
// WorkUnitService.list（同 workunit-q.routes.test.ts 模式：mock service/FileStore）。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
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

describe('GET / projectId 参数透传（#456）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    mockList.mockResolvedValue({ data: [], total: 0 });
    mockGetIndex.mockResolvedValue([]);

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
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    mockList.mockClear();
  });

  it('?projectId=PMO-1 透传 projectId', async () => {
    const res = await fetch(`${base}?projectId=${encodeURIComponent('PMO-1')}`);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'PMO-1' }));
  });

  it('不传 projectId 时透传 undefined（不过滤）', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ projectId: undefined }));
  });

  it('空串 projectId 按不过滤处理', async () => {
    const res = await fetch(`${base}?projectId=`);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ projectId: undefined }));
  });

  it('与 status=unassigned 同传（next-action 候选查询形态）', async () => {
    const res = await fetch(`${base}?projectId=PMO-1&status=unassigned`);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'PMO-1', status: 'unassigned' }));
  });
});
