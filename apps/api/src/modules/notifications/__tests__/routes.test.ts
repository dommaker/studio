/**
 * notifications routes tests — #274
 * 身份源从 x-user-id header 切换为登录态 JWT claims（req.user.id），
 * 读写端点鉴权行为一致（requireAuth + requireNotGuest）。
 * mock 中间件先例：按 authCtl 控制放行/拦截并注入 req.user。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { routes, authCtl, service } = vi.hoisted(() => ({
  routes: [] as Array<{ method: string; path: string; middlewares: Function[]; handler: Function }>,
  authCtl: {
    mode: 'ok' as 'ok' | 'unauthorized' | 'guest',
    user: { id: 'user-a', role: 'Member', name: 'Alice' } as Record<string, unknown>,
  },
  service: {
    getUserNotifications: vi.fn().mockResolvedValue([]),
    getUnreadCount: vi.fn().mockResolvedValue(3),
    markAsRead: vi.fn().mockResolvedValue(undefined),
    markAllAsRead: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('express', () => {
  const Router = vi.fn(() => {
    const r: Record<string, unknown> = {};
    for (const method of ['get', 'post']) {
      r[method] = vi.fn((path: string, ...fns: Function[]) => {
        routes.push({ method, path, middlewares: fns.slice(0, -1), handler: fns[fns.length - 1] });
        return r;
      });
    }
    return r;
  });
  return { Router, default: { Router } };
});

vi.mock('../../../middleware/auth.js', () => ({
  requireAuth: () => (req: any, res: any, next: Function) => {
    if (authCtl.mode === 'unauthorized') {
      res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' });
      return;
    }
    req.user = authCtl.user;
    next();
  },
  requireNotGuest: () => (req: any, res: any, next: Function) => {
    if (authCtl.mode === 'guest' || req.user?.role === 'Guest') {
      res.status(403).json({ error: '访客无权执行此操作，请先登录', code: 'GUEST_FORBIDDEN' });
      return;
    }
    next();
  },
}));

vi.mock('@dommaker/studio-notification', () => ({
  NotificationService: vi.fn().mockImplementation(function (this: unknown) { return service; }),
}));

vi.mock('@dommaker/studio-shared', () => ({
  FileStore: vi.fn().mockImplementation(function (this: unknown) { return {}; }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import '../routes.js';

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

async function invoke(method: string, path: string, reqOverrides: Record<string, unknown> = {}) {
  let route = routes.find(r => r.method === method && r.path === path);
  const params: Record<string, string> = {};
  if (!route) {
    // 参数化路径匹配：'/n1/read' → '/:id/read'
    route = routes.find(r => {
      if (r.method !== method) return false;
      const pattern = r.path.replace(/:[^/]+/g, '([^/]+)');
      const m = new RegExp(`^${pattern}$`).exec(path);
      if (!m) return false;
      let i = 1;
      r.path.replace(/:([^/]+)/g, (_, name) => { params[name] = m[i++]; return ''; });
      return true;
    });
  }
  expect(route, `route ${method.toUpperCase()} ${path} registered`).toBeDefined();
  const req: Record<string, unknown> = { params, query: {}, headers: {}, ...reqOverrides };
  const res = mockRes();
  let nexted = false;
  for (const mw of route!.middlewares) {
    let called = false;
    await mw(req as Request, res, () => { called = true; });
    if (!called) return { res, nexted: false };
    nexted = true;
  }
  await route!.handler(req as Request, res, () => { nexted = true; });
  return { res, nexted };
}

beforeEach(() => {
  vi.clearAllMocks();
  authCtl.mode = 'ok';
  authCtl.user = { id: 'user-a', role: 'Member', name: 'Alice' };
});

describe('#274 读写端点鉴权一致', () => {
  it.each([
    ['get', '/'],
    ['get', '/unread-count'],
    ['post', '/n1/read'],
    ['post', '/read-all'],
  ])('%s %s 未登录 → 401', async (method, path) => {
    authCtl.mode = 'unauthorized';
    const { res, nexted } = await invoke(method, path, method === 'post' && path !== '/read-all' ? { params: { id: 'n1' } } : {});
    expect(nexted).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it.each([
    ['get', '/'],
    ['get', '/unread-count'],
    ['post', '/n1/read'],
    ['post', '/read-all'],
  ])('%s %s Guest 角色 → 403', async (method, path) => {
    authCtl.mode = 'guest';
    const { res, nexted } = await invoke(method, path, method === 'post' && path !== '/read-all' ? { params: { id: 'n1' } } : {});
    expect(nexted).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('#274 身份取 JWT claims（req.user.id），不再读 x-user-id', () => {
  it('GET / 按 req.user.id 过滤，携带 x-user-id header 也被忽略', async () => {
    const { res } = await invoke('get', '/', { headers: { 'x-user-id': 'spoofed' } });
    expect(service.getUserNotifications).toHaveBeenCalledWith('user-a', expect.objectContaining({ unreadOnly: false }));
    expect(res.json).toHaveBeenCalled();
  });

  it('GET / unreadOnly=true 透传', async () => {
    await invoke('get', '/', { query: { unreadOnly: 'true' } });
    expect(service.getUserNotifications).toHaveBeenCalledWith('user-a', expect.objectContaining({ unreadOnly: true }));
  });

  it('GET /unread-count 用 req.user.id', async () => {
    const { res } = await invoke('get', '/unread-count', { headers: { 'x-user-id': 'spoofed' } });
    expect(service.getUnreadCount).toHaveBeenCalledWith('user-a');
    expect(res.json).toHaveBeenCalledWith({ count: 3 });
  });

  it('POST /:id/read 用 req.user.id 标记已读', async () => {
    const { res } = await invoke('post', '/n1/read', { params: { id: 'n1' }, headers: { 'x-user-id': 'spoofed' } });
    expect(service.markAsRead).toHaveBeenCalledWith('n1', 'user-a');
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('POST /read-all 用 req.user.id 全部已读', async () => {
    const { res } = await invoke('post', '/read-all', { headers: { 'x-user-id': 'spoofed' } });
    expect(service.markAllAsRead).toHaveBeenCalledWith('user-a');
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('鉴权放行但 user 缺失（防御）→ 500，不落到 default-user', async () => {
    authCtl.user = null as unknown as Record<string, unknown>;
    const { res } = await invoke('get', '/');
    expect(service.getUserNotifications).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
