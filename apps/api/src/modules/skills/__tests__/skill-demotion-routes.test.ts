/**
 * §10.6 skill-demotion-routes 单测：验证 3 个 handler 接线与错误兜底。
 * 核心逻辑（聚合/扫描/审批/拒绝）由 skill-demotion.test.ts 覆盖，本测试只验证路由层。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { getHandler, postHandlers } = vi.hoisted(() => ({
  getHandler: { value: null as ((...args: unknown[]) => unknown) | null },
  postHandlers: { value: [] as Array<{ path: string; fn: (...args: unknown[]) => unknown }> },
}));

const mocks = vi.hoisted(() => ({
  scanSkillDemotions: vi.fn(),
  approveDemotion: vi.fn(),
  rejectDemotion: vi.fn(),
  list: vi.fn(),
}));

vi.mock('express', () => {
  const Router = vi.fn(() => {
    const r: Record<string, unknown> = {
      get: vi.fn((...args: unknown[]) => {
        getHandler.value = args[args.length - 1] as (...args: unknown[]) => unknown;
        return r;
      }),
      post: vi.fn((path: string, ...rest: unknown[]) => {
        postHandlers.value.push({ path, fn: rest[rest.length - 1] as (...args: unknown[]) => unknown });
        return r;
      }),
      stack: [] as unknown[],
    };
    return r;
  });
  return { Router, default: { Router } };
});

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  // 路由文件现引入 middleware/auth.js（鉴权收紧），其模块加载链会 new FileStore()
  FileStore: vi.fn().mockImplementation(function () {
    return { readJson: vi.fn(), writeJson: vi.fn(), appendJsonl: vi.fn() };
  }),
}));

vi.mock('../skill-demotion.js', () => ({
  demotionProposalStore: { list: mocks.list },
  scanSkillDemotions: mocks.scanSkillDemotions,
  approveDemotion: mocks.approveDemotion,
  rejectDemotion: mocks.rejectDemotion,
}));

import '../skill-demotion-routes.js';

function mockReqRes(params: Record<string, string> = {}, query: Record<string, string> = {}): { req: Request; res: Response } {
  const req = { params, query } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('§10.6 skill-demotion routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /', () => {
    it('无 query -> 直接 list 全部', async () => {
      mocks.list.mockReturnValue([{ id: 'p1', status: 'pending' }]);

      const { req, res } = mockReqRes();
      await getHandler.value!(req, res);

      expect(mocks.scanSkillDemotions).not.toHaveBeenCalled();
      expect(mocks.list).toHaveBeenCalledWith({});
      expect(res.json).toHaveBeenCalledWith({ data: [{ id: 'p1', status: 'pending' }] });
    });

    it('?status=pending -> 传入 status 过滤', async () => {
      mocks.list.mockReturnValue([]);

      const { req, res } = mockReqRes({}, { status: 'pending' });
      await getHandler.value!(req, res);

      expect(mocks.list).toHaveBeenCalledWith({ status: 'pending' });
    });

    it('?scan=true -> 先扫描再 list（返回 scan 摘要）', async () => {
      mocks.scanSkillDemotions.mockResolvedValue({ scanned: 5, created: 2 });
      mocks.list.mockReturnValue([]);

      const { req, res } = mockReqRes({}, { scan: 'true' });
      await getHandler.value!(req, res);

      expect(mocks.scanSkillDemotions).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ data: [], scan: { scanned: 5, created: 2 } });
    });
  });

  describe('POST /:id/approve', () => {
    it('approveDemotion 返回 true -> 200 success', async () => {
      mocks.approveDemotion.mockResolvedValue(true);
      const handler = postHandlers.value.find(h => h.path === '/:id/approve')!;

      const { req, res } = mockReqRes({ id: 'p1' });
      await handler.fn(req, res);

      expect(mocks.approveDemotion).toHaveBeenCalledWith('p1');
      expect(res.json).toHaveBeenCalledWith({ success: true, status: 'approved' });
    });

    it('approveDemotion 返回 false -> 404 NOT_FOUND', async () => {
      mocks.approveDemotion.mockResolvedValue(false);
      const handler = postHandlers.value.find(h => h.path === '/:id/approve')!;

      const { req, res } = mockReqRes({ id: 'missing' });
      await handler.fn(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'NOT_FOUND' }),
      }));
    });
  });

  describe('POST /:id/reject', () => {
    it('rejectDemotion 返回 true -> 200 success', async () => {
      mocks.rejectDemotion.mockResolvedValue(true);
      const handler = postHandlers.value.find(h => h.path === '/:id/reject')!;

      const { req, res } = mockReqRes({ id: 'p2' });
      await handler.fn(req, res);

      expect(mocks.rejectDemotion).toHaveBeenCalledWith('p2');
      expect(res.json).toHaveBeenCalledWith({ success: true, status: 'rejected' });
    });

    it('rejectDemotion 返回 false -> 404 NOT_FOUND', async () => {
      mocks.rejectDemotion.mockResolvedValue(false);
      const handler = postHandlers.value.find(h => h.path === '/:id/reject')!;

      const { req, res } = mockReqRes({ id: 'missing' });
      await handler.fn(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
