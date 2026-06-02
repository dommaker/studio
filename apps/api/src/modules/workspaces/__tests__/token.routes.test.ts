/**
 * Token Routes tests — generate/list/revoke token endpoints
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { routeHandlers, workspaceTokenMock } = vi.hoisted(() => ({
  routeHandlers: new Map<string, Function>(),
  workspaceTokenMock: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('express', () => {
  const Router = vi.fn(() => {
    const r: any = {};
    for (const method of ['get', 'post', 'delete', 'put', 'patch']) {
      r[method] = vi.fn((...args: any[]) => {
        const path = args[0];
        const handler = args[args.length - 1];
        routeHandlers.set(`${method}:${path}`, handler);
        return r;
      });
    }
    r.stack = [];
    return r;
  });
  return { Router, default: { Router } };
});

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: { workspaceToken: workspaceTokenMock },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: () => (_req: unknown, _res: unknown, next: unknown) => (next as Function)(),
}));

import '../token.routes.js';

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('POST / (generate token)', () => {
  beforeEach(() => {
    workspaceTokenMock.create.mockReset();
  });

  it('returns 400 when name is missing', async () => {
    const handler = routeHandlers.get('post:/')!;
    const req = { body: {} } as Request;
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'MISSING_TOKEN_NAME',
    }));
  });

  it('returns 400 when permissions is not array', async () => {
    const handler = routeHandlers.get('post:/')!;
    const req = { body: { name: 'test', permissions: 'bad' } } as unknown as Request;
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'INVALID_PERMISSIONS',
    }));
  });

  it('creates token and returns plaintext', async () => {
    workspaceTokenMock.create.mockResolvedValueOnce({
      id: 'tok-1',
      name: 'my-token',
    });

    const handler = routeHandlers.get('post:/')!;
    const req = { body: { name: 'my-token' } } as Request;
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const call = (res.json as any).mock.calls[0][0];
    expect(call.success).toBe(true);
    expect(call.data.token).toMatch(/^st_mach_/);
    expect(call.data.name).toBe('my-token');
  });

  it('generates st_mach_ prefixed token with sufficient entropy', async () => {
    workspaceTokenMock.create.mockResolvedValueOnce({ id: 'tok-1', name: 'test' });

    const handler = routeHandlers.get('post:/')!;
    const req = { body: { name: 'test' } } as Request;
    const res = mockRes();

    await handler(req, res);

    const call = (res.json as any).mock.calls[0][0];
    expect(call.data.token).toMatch(/^st_mach_[A-Za-z0-9_-]{32}$/);
  });
});

describe('GET / (list tokens)', () => {
  beforeEach(() => {
    workspaceTokenMock.findMany.mockReset();
  });

  it('returns masked token list', async () => {
    workspaceTokenMock.findMany.mockResolvedValueOnce([{
      id: 'tok-1',
      name: 'token-1',
      tokenHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      permissions: '["execute"]',
      createdAt: new Date(),
      revokedAt: null,
      _count: { workspaces: 2 },
    }]);

    const handler = routeHandlers.get('get:/')!;
    const req = {} as Request;
    const res = mockRes();

    await handler(req, res);

    const call = (res.json as any).mock.calls[0][0];
    expect(call.success).toBe(true);
    expect(call.data).toHaveLength(1);
    expect(call.data[0].tokenHash).toBe('abcdef1234...');
    expect(call.data[0].workspaceCount).toBe(2);
  });
});

describe('DELETE /:id (revoke token)', () => {
  beforeEach(() => {
    workspaceTokenMock.findUnique.mockReset();
    workspaceTokenMock.update.mockReset();
  });

  it('returns 404 when token not found', async () => {
    workspaceTokenMock.findUnique.mockResolvedValueOnce(null);

    const handler = routeHandlers.get('delete:/:id')!;
    const req = { params: { id: 'nonexistent' } } as unknown as Request;
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'WORKSPACE_TOKEN_NOT_FOUND',
    }));
  });

  it('returns 400 when already revoked', async () => {
    workspaceTokenMock.findUnique.mockResolvedValueOnce({
      id: 'tok-1',
      revokedAt: new Date(),
    });

    const handler = routeHandlers.get('delete:/:id')!;
    const req = { params: { id: 'tok-1' } } as unknown as Request;
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'WORKSPACE_TOKEN_ALREADY_REVOKED',
    }));
  });

  it('revokes token successfully', async () => {
    workspaceTokenMock.findUnique.mockResolvedValueOnce({
      id: 'tok-1',
      name: 'my-token',
      revokedAt: null,
    });
    workspaceTokenMock.update.mockResolvedValueOnce({
      id: 'tok-1',
      name: 'my-token',
      revokedAt: new Date('2026-06-01'),
    });

    const handler = routeHandlers.get('delete:/:id')!;
    const req = { params: { id: 'tok-1' } } as unknown as Request;
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
    }));
    expect(workspaceTokenMock.update).toHaveBeenCalledWith({
      where: { id: 'tok-1' },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
