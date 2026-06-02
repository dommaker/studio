/**
 * Discover Proxy tests — Express route handler
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { routeHandler, discoverViaWsMock, isWorkspaceConnectedMock } = vi.hoisted(() => ({
  routeHandler: { value: null as Function | null },
  discoverViaWsMock: vi.fn(),
  isWorkspaceConnectedMock: vi.fn(),
}));

vi.mock('express', () => {
  const Router = vi.fn(() => {
    const r = {
      get: vi.fn((...args: any[]) => {
        routeHandler.value = args[args.length - 1];
        return r;
      }),
      stack: [],
    };
    return r;
  });
  return { Router, default: { Router } };
});

vi.mock('../ws-gateway.js', () => ({
  discoverViaWs: (...args: unknown[]) => discoverViaWsMock(...args),
  isWorkspaceConnected: (...args: unknown[]) => isWorkspaceConnectedMock(...args),
}));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: () => (_req: unknown, _res: unknown, next: unknown) => (next as Function)(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import '../discover-proxy.js';

function mockReqRes(params: Record<string, string>, query: Record<string, string> = {}) {
  const req = { params, query } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('discover-proxy route', () => {
  beforeEach(() => {
    discoverViaWsMock.mockReset();
    isWorkspaceConnectedMock.mockReset();
  });

  it('returns 400 when path query is missing', async () => {
    const { req, res } = mockReqRes({ id: 'ws-1' });
    await routeHandler.value!(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'MISSING_PATH',
    }));
  });

  it('returns 503 when workspace not connected', async () => {
    isWorkspaceConnectedMock.mockReturnValue(false);
    const { req, res } = mockReqRes({ id: 'ws-1' }, { path: '/home' });
    await routeHandler.value!(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'WORKSPACE_NOT_CONNECTED',
    }));
  });

  it('returns entries on success', async () => {
    isWorkspaceConnectedMock.mockReturnValue(true);
    discoverViaWsMock.mockResolvedValue([
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file' },
    ]);

    const { req, res } = mockReqRes({ id: 'ws-1' }, { path: '/home' });
    await routeHandler.value!(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [
        { name: 'src', type: 'directory' },
        { name: 'README.md', type: 'file' },
      ],
      total: 2,
    });
  });

  it('returns 504 on timeout', async () => {
    isWorkspaceConnectedMock.mockReturnValue(true);
    discoverViaWsMock.mockRejectedValue(new Error('timed out'));

    const { req, res } = mockReqRes({ id: 'ws-1' }, { path: '/home' });
    await routeHandler.value!(req, res);

    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'DISCOVER_TIMEOUT',
    }));
  });

  it('returns 503 on no active connection error', async () => {
    isWorkspaceConnectedMock.mockReturnValue(true);
    discoverViaWsMock.mockRejectedValue(new Error('No active connection for workspace'));

    const { req, res } = mockReqRes({ id: 'ws-1' }, { path: '/home' });
    await routeHandler.value!(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'WORKSPACE_NOT_CONNECTED',
    }));
  });

  it('returns 500 on generic error', async () => {
    isWorkspaceConnectedMock.mockReturnValue(true);
    discoverViaWsMock.mockRejectedValue(new Error('something broke'));

    const { req, res } = mockReqRes({ id: 'ws-1' }, { path: '/home' });
    await routeHandler.value!(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'DISCOVER_PROXY_ERROR',
    }));
  });

  it('passes custom timeout to discoverViaWs', async () => {
    isWorkspaceConnectedMock.mockReturnValue(true);
    discoverViaWsMock.mockResolvedValue([]);

    const { req, res } = mockReqRes({ id: 'ws-1' }, { path: '/home', timeout: '5000' });
    await routeHandler.value!(req, res);

    expect(discoverViaWsMock).toHaveBeenCalledWith('ws-1', '/home', 5000);
  });
});
