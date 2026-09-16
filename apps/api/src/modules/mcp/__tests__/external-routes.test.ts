/**
 * P1（#566）：/api/v1/mcp/external/* 外部只读入口接线测试。
 *
 * - GET /external/sse + POST /external/messages 路由存在且挂 requireLocalhost 中间件
 * - 外部 messages 处理器钉死 { pinnedRoleId: 'external', audience: 'external' }
 * - 内部 /messages 处理器不传 ctx（现状不变）
 * - AC6：外部入口中间件拒绝带 X-Forwarded-For 的请求
 *
 * server.js 被 mock（仅断言 handleRequest 入参）；tools.js 走真实门面注册。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { mockHandleRequest } = vi.hoisted(() => ({
  mockHandleRequest: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} }),
}));

vi.mock('../server.js', () => ({
  mcpServer: { handleRequest: mockHandleRequest },
}));

import router from '../routes.js';

interface RouteLayer {
  path: string;
  methods: Record<string, boolean>;
  stack: Array<{ handle: (req: any, res: any, next?: any) => any }>;
}

function findRoute(method: string, path: string): RouteLayer {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route as RouteLayer;
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: any) { res.body = payload; return res; },
    writeHead() { return res; },
    write() { return true; },
  };
  return res as Response;
}

describe('/mcp/external/* 入口接线（#566）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /external/sse 与 POST /external/messages 存在，且 handler 前挂中间件（requireLocalhost）', () => {
    expect(findRoute('get', '/external/sse').stack.length).toBeGreaterThanOrEqual(2);
    expect(findRoute('post', '/external/messages').stack.length).toBeGreaterThanOrEqual(2);
  });

  it('外部 messages 处理器钉死 external 角色 + external audience', async () => {
    const route = findRoute('post', '/external/messages');
    const handler = route.stack[route.stack.length - 1].handle;
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    await handler({ query: {}, body } as unknown as Request, fakeRes());
    expect(mockHandleRequest).toHaveBeenCalledWith(body, { pinnedRoleId: 'external', audience: 'external' });
  });

  it('内部 /messages 处理器不传 ctx（行为不变）', async () => {
    const route = findRoute('post', '/messages');
    const handler = route.stack[route.stack.length - 1].handle;
    const body = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    await handler({ query: {}, body } as unknown as Request, fakeRes());
    expect(mockHandleRequest).toHaveBeenCalledWith(body, undefined);
  });

  it('AC6：外部入口中间件拒绝带 X-Forwarded-For 的请求', async () => {
    const route = findRoute('get', '/external/sse');
    const localhostMw = route.stack[0].handle;
    const res = fakeRes();
    const next = vi.fn();
    await localhostMw({ headers: { 'x-forwarded-for': '203.0.113.9' }, ip: '127.0.0.1' }, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('内部 /sse /messages / POST / 路由保持注册（回归）', () => {
    expect(findRoute('get', '/sse')).toBeTruthy();
    expect(findRoute('post', '/messages')).toBeTruthy();
    expect(findRoute('post', '/')).toBeTruthy();
  });
});
