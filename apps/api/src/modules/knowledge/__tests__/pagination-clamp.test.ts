/**
 * #359: knowledge 分页入口统一走 parsePagination（clamp 1..100）
 *
 * 修复前三处三个口径（search clamp 50 / entries|unified clamp 100 / export 无 clamp）。
 * 行为口径变化（缺省值）：search 10→20、export 100→20、unified 50→20、
 * entries 无 limit 时从不设限 → 缺省 20。
 *
 * mock 掉 store/service 层，直接驱动 router handler，断言传入下游的 limit。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router, type RequestHandler } from 'express';

// ── Hoisted mocks ─────────────────────────────────────────────────────
const mockSharedStoreList = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => vi.fn());
const mockList = vi.hoisted(() => vi.fn());
const mockGapQuery = vi.hoisted(() => vi.fn());
const mockListEntries = vi.hoisted(() => vi.fn());

vi.mock('../knowledge-bus.service.js', () => ({
  sharedStore: { list: mockSharedStoreList },
}));
vi.mock('../knowledge-service.js', () => ({
  knowledgeService: { search: mockSearch, list: mockList },
}));
vi.mock('../knowledge-query.service.js', () => ({
  knowledgeQuery: { query: mockGapQuery },
}));
vi.mock('../engine/unified-query.js', () => ({
  UnifiedQuery: vi.fn().mockImplementation(function () {
    return { listEntries: mockListEntries };
  }),
}));
vi.mock('../../agents/system-executor.js', () => ({
  getSystemExecutor: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────
import { entriesRoutes } from '../entries.routes.js';
import { knowledgeServiceRoutes } from '../knowledge-service.routes.js';

// ── Helpers ───────────────────────────────────────────────────────────
function createReq(query: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  return { method: 'GET', url: '/', headers: {}, query, params, body: {}, get: () => undefined } as any;
}
function createRes() {
  const res: Record<string, any> = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.send = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res as any;
}
function getHandler(router: Router, method: string, path: string): RequestHandler {
  for (const layer of (router as any).stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`Handler not found: ${method} ${path}`);
}

describe('knowledge 分页 clamp (#359)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSharedStoreList.mockReturnValue(
      Array.from({ length: 150 }, (_, i) => ({ id: `e${i}`, title: `t${i}`, content: 'c' })),
    );
    mockSearch.mockResolvedValue([]);
    mockList.mockResolvedValue([]);
    mockGapQuery.mockResolvedValue([]);
    mockListEntries.mockResolvedValue({ entries: [], total: 0 });
  });

  it('GET /export?limit=9999 → 截断 100 条（修复前无 clamp 全量返回）', async () => {
    const res = createRes();
    await getHandler(entriesRoutes, 'get', '/export')(createReq({ format: 'json', limit: '9999' }), res, () => undefined);
    const entries = JSON.parse(res.send.mock.calls[0][0]);
    expect(entries).toHaveLength(100);
  });

  it('GET /export 缺省 limit=20（原缺省 100）', async () => {
    const res = createRes();
    await getHandler(entriesRoutes, 'get', '/export')(createReq({ format: 'json' }), res, () => undefined);
    const entries = JSON.parse(res.send.mock.calls[0][0]);
    expect(entries).toHaveLength(20);
  });

  it('GET /gaps/:type?limit=9999 → 下游 limit clamp 100（修复前 9999 直通）', async () => {
    const res = createRes();
    await getHandler(entriesRoutes, 'get', '/gaps/:type')(createReq({ limit: '9999' }, { type: 'preference' }), res, () => undefined);
    expect(mockGapQuery.mock.calls[0][0].limit).toBe(100);
  });

  it('GET /unified 缺省 limit=20（原缺省 50）；limit=9999 clamp 100', async () => {
    const res = createRes();
    await getHandler(entriesRoutes, 'get', '/unified')(createReq({}), res, () => undefined);
    expect(mockListEntries.mock.calls[0][0].limit).toBe(20);

    await getHandler(entriesRoutes, 'get', '/unified')(createReq({ limit: '9999' }), createRes(), () => undefined);
    expect(mockListEntries.mock.calls[1][0].limit).toBe(100);
  });

  it('GET /knowledge-service/search?limit=999 → clamp 100（修复前 clamp 50）', async () => {
    const res = createRes();
    await getHandler(knowledgeServiceRoutes, 'get', '/search')(createReq({ q: 'x', limit: '999' }), res, () => undefined);
    expect(mockSearch.mock.calls[0][1].limit).toBe(100);
  });

  it('GET /knowledge-service/search 缺省 limit=20（原缺省 10）', async () => {
    const res = createRes();
    await getHandler(knowledgeServiceRoutes, 'get', '/search')(createReq({ q: 'x' }), res, () => undefined);
    expect(mockSearch.mock.calls[0][1].limit).toBe(20);
  });

  it('GET /knowledge-service/entries 缺省 limit=20（修复前不设限）；limit=999 clamp 100', async () => {
    await getHandler(knowledgeServiceRoutes, 'get', '/entries')(createReq({}), createRes(), () => undefined);
    expect(mockList.mock.calls[0][0].limit).toBe(20);

    await getHandler(knowledgeServiceRoutes, 'get', '/entries')(createReq({ limit: '999' }), createRes(), () => undefined);
    expect(mockList.mock.calls[1][0].limit).toBe(100);
  });
});
