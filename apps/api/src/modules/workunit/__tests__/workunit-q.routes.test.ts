// 批次 D-2 项4：GET /workunits?q= 路由契约测试 —— 查询参数正确透传到
// WorkUnitService.list（同 workunit-unattributed.routes.test.ts 模式：mock service/FileStore）。
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

describe('GET / q 参数透传（批次 D-2 项4）', () => {
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

  it('?q=登录 透传 q（URL 编码）', async () => {
    const res = await fetch(`${base}?q=${encodeURIComponent('登录')}`);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ q: '登录' }));
  });

  it('q 首尾空白被裁掉', async () => {
    const res = await fetch(`${base}?q=${encodeURIComponent('  登录  ')}`);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ q: '登录' }));
  });

  it('不传 q 时透传 undefined（不过滤）', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ q: undefined }));
  });

  it('空白 q（空串/纯空格）按不过滤处理', async () => {
    const res = await fetch(`${base}?q=${encodeURIComponent('   ')}`);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ q: undefined }));
  });

  it('与 status 过滤同传（交集语义在 service 层）', async () => {
    const res = await fetch(`${base}?q=login&status=active`);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ q: 'login', status: 'active' }));
  });
});
