/**
 * Transcript routes unit tests — #174: WU transcript 只读查看（#60 C5）
 *
 * 模式同 events/__tests__/event.routes.test.ts：vi.hoisted mock FileStore（readJsonl），
 * getHandlers/invokeRoute helper 直接驱动 router。
 * STUDIO_AUTH=none 下 requireAuth 放行，不测 401。
 *
 * Covers: GET /:workUnitId — 分页 slice / total / 默认参数 / limit 上限（#359 起 50→100）/ 非法 id 400 / 空文件 200
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from 'express';

// ── Hoisted mocks ─────────────────────────────────────────────────────
const mockReadJsonl = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  FileStore: vi.fn().mockImplementation(function () { return {
    readJsonl: mockReadJsonl,
  }; }),
}));

// ── Imports after mocks ───────────────────────────────────────────────
import routes from '../transcript.routes.js';

// ── Helpers (events/event.routes.test.ts pattern) ─────────────────────

function createReq(overrides: Record<string, any> = {}) {
  return {
    method: 'GET',
    url: '/',
    headers: {},
    body: {},
    ip: '127.0.0.1',
    query: {},
    params: {},
    cookies: {},
    socket: { remoteAddress: '127.0.0.1' },
    get: () => undefined,
    ...overrides,
  };
}

function createRes() {
  const json = vi.fn();
  const res: Record<string, any> = {
    status: vi.fn(() => res),
    json,
  };
  return res as any;
}

function getHandlers(router: Router, method: string, path: string): Function[] {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack.map((l: any) => l.handle);
    }
  }
  throw new Error(`Handler not found: ${method} ${path}`);
}

async function invokeRoute(
  router: Router,
  method: string,
  path: string,
  reqOverrides: Record<string, any> = {}
) {
  const handlers = getHandlers(router, method, path);
  const req = createReq(reqOverrides);
  const res = createRes();
  let i = 0;
  const next = async () => {
    if (i < handlers.length) {
      await handlers[i++](req, res, next);
    }
  };
  await next();
  return { req, res };
}

const entry = (step: number) => ({
  workUnitId: 'wu-1',
  step,
  action: 'progress',
  rawOutput: `step-${step} output`,
  createdAt: '2026-08-15T10:00:00.000Z',
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('GET /:workUnitId (#174)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJsonl.mockResolvedValue([entry(1), entry(2), entry(3)]);
  });

  it('返回全部条目：total 正确，默认 offset=0 / limit=20', async () => {
    const { res } = await invokeRoute(routes, 'get', '/:workUnitId', {
      params: { workUnitId: 'wu-1' },
    });

    const body = res.json.mock.calls[0][0];
    expect(body.workUnitId).toBe('wu-1');
    expect(body.total).toBe(3);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(20);
    expect(body.entries).toHaveLength(3);
    expect(body.entries[0].step).toBe(1);
  });

  it('分页：offset+limit 正确 slice', async () => {
    const { res } = await invokeRoute(routes, 'get', '/:workUnitId', {
      params: { workUnitId: 'wu-1' },
      query: { offset: '1', limit: '1' },
    });

    const body = res.json.mock.calls[0][0];
    expect(body.total).toBe(3);
    expect(body.offset).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].step).toBe(2);
  });

  it('limit 上限截断为 100（#359：统一走 parsePagination clamp 1..100，原上限 50）', async () => {
    mockReadJsonl.mockResolvedValueOnce(Array.from({ length: 120 }, (_, i) => entry(i + 1)));

    const { res } = await invokeRoute(routes, 'get', '/:workUnitId', {
      params: { workUnitId: 'wu-1' },
      query: { limit: '999' },
    });

    const body = res.json.mock.calls[0][0];
    expect(body.limit).toBe(100);
    expect(body.entries).toHaveLength(100);
    expect(body.total).toBe(120);
  });

  it('非法 workUnitId（含 /）→ 400 不读盘', async () => {
    const { res } = await invokeRoute(routes, 'get', '/:workUnitId', {
      params: { workUnitId: 'a/b' },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockReadJsonl).not.toHaveBeenCalled();
  });

  it('非法 workUnitId（含 ..）→ 400 不读盘', async () => {
    const { res } = await invokeRoute(routes, 'get', '/:workUnitId', {
      params: { workUnitId: '..%2F..%2Fetc'.replace(/%2F/g, '/') },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockReadJsonl).not.toHaveBeenCalled();
  });

  it('文件不存在（readJsonl 返回 []）→ 200 空列表不 404', async () => {
    mockReadJsonl.mockResolvedValueOnce([]);

    const { res } = await invokeRoute(routes, 'get', '/:workUnitId', {
      params: { workUnitId: 'wu-nope' },
    });

    const body = res.json.mock.calls[0][0];
    expect(res.status).not.toHaveBeenCalled();
    expect(body.total).toBe(0);
    expect(body.entries).toEqual([]);
  });

  it('readJsonl 抛错 → 500', async () => {
    mockReadJsonl.mockRejectedValueOnce(new Error('IO error'));

    const { res } = await invokeRoute(routes, 'get', '/:workUnitId', {
      params: { workUnitId: 'wu-1' },
    });

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
