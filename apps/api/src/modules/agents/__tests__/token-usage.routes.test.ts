/**
 * §10.5 token-usage.routes 单测：验证 GET /:id/token-usage handler
 * 委托 token-usage.service.getAgentTokenUsage，本测试只验证路由接线与错误兜底。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { routeHandler } = vi.hoisted(() => ({
  routeHandler: { value: null as ((...args: unknown[]) => unknown) | null },
}));

const { getAgentTokenUsageMock } = vi.hoisted(() => ({
  getAgentTokenUsageMock: vi.fn(),
}));

vi.mock('express', () => {
  const Router = vi.fn(() => {
    const r: Record<string, unknown> = {
      get: vi.fn((...args: unknown[]) => {
        routeHandler.value = args[args.length - 1] as (...args: unknown[]) => unknown;
        return r;
      }),
      stack: [] as unknown[],
    };
    return r;
  });
  return { Router, default: { Router } };
});

vi.mock('../token-usage.service.js', () => ({
  getAgentTokenUsage: getAgentTokenUsageMock,
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import '../token-usage.routes.js';

function mockReqRes(id: string): { req: Request; res: Response } {
  const req = { params: { id } } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('§10.5 GET /:id/token-usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功 -> 200 返回 service 聚合结果', async () => {
    const usage = {
      profileId: 'profile-a',
      totals: { injectedTokens: 100, executionTokens: 900, totalTokens: 1000 },
      today: { injectedTokens: 100, executionTokens: 900, totalTokens: 1000 },
      rolling7d: { injectedTokens: 100, executionTokens: 900, totalTokens: 1000 },
      workUnitCount: 1,
      trees: { participated: 1, avgTreeDepth: 1 },
      generatedAt: '2026-07-21T00:00:00.000Z',
    };
    getAgentTokenUsageMock.mockResolvedValue(usage);

    const { req, res } = mockReqRes('profile-a');
    await routeHandler.value!(req, res);

    expect(getAgentTokenUsageMock).toHaveBeenCalledWith('profile-a');
    expect(res.json).toHaveBeenCalledWith(usage);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('空数据 -> 200 返回全零（service 层约定不抛）', async () => {
    const zero = {
      profileId: 'profile-empty',
      totals: { injectedTokens: 0, executionTokens: 0, totalTokens: 0 },
      today: { injectedTokens: 0, executionTokens: 0, totalTokens: 0 },
      rolling7d: { injectedTokens: 0, executionTokens: 0, totalTokens: 0 },
      workUnitCount: 0,
      trees: { participated: 0, avgTreeDepth: 0 },
      generatedAt: '2026-07-21T00:00:00.000Z',
    };
    getAgentTokenUsageMock.mockResolvedValue(zero);

    const { req, res } = mockReqRes('profile-empty');
    await routeHandler.value!(req, res);

    expect(res.json).toHaveBeenCalledWith(zero);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('service 抛错 -> 500 兜底（防御式，service 层已保证不抛）', async () => {
    getAgentTokenUsageMock.mockRejectedValue(new Error('unexpected'));

    const { req, res } = mockReqRes('profile-x');
    await routeHandler.value!(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      }),
    );
  });
});
