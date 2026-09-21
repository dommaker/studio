/**
 * audit-logs routes 注册测试 (#256)
 *
 * AC: POST /cleanup 端点下线--删除语义统一归 #213 轮转机制
 * （audit.jsonl 热 90 天 -> 月度 gzip 归档，只增不删）。
 *
 * 本测试为 #256 下线端点后的回归保护：防止后续误重新注册
 * 物理删除端点，绕过 #213「只增不删」决议。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── #359: 分页 clamp 测试用 AuditService mock（hoisted，先于 router import）──
const mockAuditQuery = vi.hoisted(() => vi.fn());
const mockAuditExport = vi.hoisted(() => vi.fn());
const mockAuditGetById = vi.hoisted(() => vi.fn());
const mockQueryProposalRows = vi.hoisted(() => vi.fn());
const mockGetProposalRowById = vi.hoisted(() => vi.fn());

vi.mock('@dommaker/studio-audit', () => ({
  AuditService: vi.fn().mockImplementation(function () {
    return { query: mockAuditQuery, export: mockAuditExport, getById: mockAuditGetById };
  }),
  AuditActions: { LOGIN: 'login' },
  AuditResources: { USER: 'user' },
}));

vi.mock('../proposal-source.js', () => ({
  queryProposalDecisionRows: mockQueryProposalRows,
  getProposalDecisionRowById: mockGetProposalRowById,
}));

import router from '../routes';

interface FlatRoute { method: string; path: string }

function flattenRoutes(r: any): FlatRoute[] {
  const out: FlatRoute[] = [];
  for (const layer of r.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) {
        out.push({ method: m.toUpperCase(), path: layer.route.path });
      }
    }
  }
  return out;
}

describe('audit-logs routes (#256: cleanup 端点下线)', () => {
  const routes = flattenRoutes(router);

  it('POST /cleanup 不再注册--物理删除路径已下线，删除语义归 #213 轮转机制', () => {
    const hasCleanup = routes.some(
      r => r.method === 'POST' && r.path === '/cleanup',
    );
    expect(hasCleanup).toBe(false);
  });

  it('其他 AR-012 端点保持注册（回归保护）', () => {
    const paths = routes.map(r => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /');
    expect(paths).toContain('GET /stats');
    expect(paths).toContain('GET /actions');
    expect(paths).toContain('GET /resources');
    expect(paths).toContain('POST /');
    expect(paths).toContain('GET /export');
  });
});

/**
 * #359: GET / 分页参数统一走 parsePagination（clamp 1..100）。
 * 修复前 limit=999999 直通 service.query（安全/性能豁口）。
 * 行为口径变化：缺省 limit 50 → 20（parsePagination 统一缺省）。
 */
describe('audit-logs GET / 分页 clamp (#359)', () => {
  function createReq(query: Record<string, unknown>) {
    return { method: 'GET', url: '/', headers: {}, query, params: {}, body: {}, get: () => undefined } as any;
  }
  function createRes() {
    const res: Record<string, any> = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res as any;
  }
  async function invokeList(query: Record<string, unknown>) {
    const layer = (router as any).stack.find(
      (l: any) => l.route && l.route.path === '/' && l.route.methods.get,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = createRes();
    await handler(createReq(query), res, () => undefined);
    return res;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditQuery.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
  });

  it('limit=999999 clamp 到 100，不再直通 query（豁口封堵）', async () => {
    await invokeList({ limit: '999999' });
    expect(mockAuditQuery).toHaveBeenCalledTimes(1);
    expect(mockAuditQuery.mock.calls[0][0].limit).toBe(100);
  });

  it('缺省分页：page=1 / limit=20（parsePagination 统一缺省）', async () => {
    await invokeList({});
    expect(mockAuditQuery.mock.calls[0][0].page).toBe(1);
    expect(mockAuditQuery.mock.calls[0][0].limit).toBe(20);
  });

  it('page=0 / limit=-5 clamp 到 page=1 / limit=1', async () => {
    await invokeList({ page: '0', limit: '-5' });
    expect(mockAuditQuery.mock.calls[0][0].page).toBe(1);
    expect(mockAuditQuery.mock.calls[0][0].limit).toBe(1);
  });
});

/**
 * GET /export 过滤透传：action/resource/status 必须进 service.export。
 * 修复前路由层静默丢弃这三个参数（E7 前端已带上），导出与列表口径不一致。
 */
describe('audit-logs GET /export 过滤透传', () => {
  function createReq(query: Record<string, unknown>) {
    return { method: 'GET', url: '/export', headers: {}, query, params: {}, body: {}, get: () => undefined } as any;
  }
  function createRes() {
    const res: Record<string, any> = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    res.setHeader = vi.fn(() => res);
    return res as any;
  }
  async function invokeExport(query: Record<string, unknown>) {
    const layer = (router as any).stack.find(
      (l: any) => l.route && l.route.path === '/export' && l.route.methods.get,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = createRes();
    await handler(createReq(query), res, () => undefined);
    return res;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditExport.mockResolvedValue([]);
  });

  it('GET /export 注册在 GET /:id 之前，不被通配路由遮蔽（历史 bug 回归保护）', () => {
    const order = flattenRoutes(router).map(r => `${r.method} ${r.path}`);
    expect(order.indexOf('GET /export')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('GET /export')).toBeLessThan(order.indexOf('GET /:id'));
  });

  it('action/resource/status 透传到 service.export（不再静默丢弃）', async () => {
    await invokeExport({ action: 'login', resource: 'user', status: 'failure' });
    expect(mockAuditExport).toHaveBeenCalledTimes(1);
    const q = mockAuditExport.mock.calls[0][0];
    expect(q.action).toBe('login');
    expect(q.resource).toBe('user');
    expect(q.status).toBe('failure');
  });

  it('userId/companyId/时间范围保持透传（回归保护）', async () => {
    await invokeExport({
      userId: 'u1',
      companyId: 'c1',
      startTime: '2026-09-01T00:00:00.000Z',
      endTime: '2026-09-02T00:00:00.000Z',
    });
    const q = mockAuditExport.mock.calls[0][0];
    expect(q.userId).toBe('u1');
    expect(q.companyId).toBe('c1');
    expect(q.startTime).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(q.endTime).toEqual(new Date('2026-09-02T00:00:00.000Z'));
  });
});

/**
 * #591：source 维度（operation|proposal|all）+ actorType 透传。
 * 缺省 source=operation 保持既有客户端行为不变；source 含 proposal 时合并
 * review-proposal 聚合行后统一排序分页。
 */
describe('audit-logs source/actorType 维度 (#591)', () => {
  function createReq(query: Record<string, unknown>, url = '/') {
    return { method: 'GET', url, headers: {}, query, params: {}, body: {}, get: () => undefined } as any;
  }
  function createRes() {
    const res: Record<string, any> = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    res.setHeader = vi.fn(() => res);
    return res as any;
  }
  async function invokeList(query: Record<string, unknown>) {
    const layer = (router as any).stack.find(
      (l: any) => l.route && l.route.path === '/' && l.route.methods.get,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = createRes();
    await handler(createReq(query), res, () => undefined);
    return res;
  }
  async function invokeGetById(id: string) {
    const layer = (router as any).stack.find(
      (l: any) => l.route && l.route.path === '/:id' && l.route.methods.get,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = createRes();
    const req = createReq({});
    req.params = { id };
    await handler(req, res, () => undefined);
    return res;
  }

  const opRow = { id: 'op-1', action: 'create', resource: 'task', status: 'success', createdAt: '2026-09-01T00:00:00.000Z' };
  const propRow = { id: 'p-1', actorType: 'agent', action: 'propose', resource: 'distill', resourceId: 'p-1', status: 'executed', createdAt: '2026-09-05T00:00:00.000Z', details: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditQuery.mockResolvedValue({ data: [opRow], total: 1, page: 1, limit: 10000 });
    mockQueryProposalRows.mockResolvedValue([propRow]);
    mockAuditGetById.mockResolvedValue(null);
    mockGetProposalRowById.mockResolvedValue(null);
  });

  it('actorType 透传到 service.query', async () => {
    await invokeList({ actorType: 'agent' });
    expect(mockAuditQuery.mock.calls[0][0].actorType).toBe('agent');
  });

  it('缺省 source=operation：不查提案源（既有行为不变）', async () => {
    const res = await invokeList({});
    expect(mockAuditQuery).toHaveBeenCalledTimes(1);
    expect(mockQueryProposalRows).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].pagination.total).toBe(1);
  });

  it('source=proposal：只查提案源，不查操作轨', async () => {
    const res = await invokeList({ source: 'proposal' });
    expect(mockAuditQuery).not.toHaveBeenCalled();
    expect(mockQueryProposalRows).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0][0];
    expect(body.pagination.total).toBe(1);
    expect(body.data[0].id).toBe('p-1');
  });

  it('source=all：合并两源按 createdAt 降序分页', async () => {
    const res = await invokeList({ source: 'all' });
    const body = res.json.mock.calls[0][0];
    expect(body.pagination.total).toBe(2);
    expect(body.data.map((r: any) => r.id)).toEqual(['p-1', 'op-1']);
  });

  it('source=all + actorType=agent：提案源收到过滤参数', async () => {
    await invokeList({ source: 'all', actorType: 'agent' });
    expect(mockQueryProposalRows.mock.calls[0][0].actorType).toBe('agent');
    expect(mockAuditQuery.mock.calls[0][0].actorType).toBe('agent');
  });

  it('source=all 分页截断在合并后应用', async () => {
    mockAuditQuery.mockResolvedValue({ data: [opRow], total: 1, page: 1, limit: 10000 });
    const res = await invokeList({ source: 'all', limit: '1' });
    const body = res.json.mock.calls[0][0];
    expect(body.pagination.total).toBe(2);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('p-1');
  });

  it('GET /:id 操作轨未命中时回查提案源', async () => {
    mockGetProposalRowById.mockResolvedValue(propRow);
    const res = await invokeGetById('p-1');
    expect(mockAuditGetById).toHaveBeenCalledWith('p-1');
    expect(mockGetProposalRowById).toHaveBeenCalledWith('p-1');
    expect(res.json.mock.calls[0][0].id).toBe('p-1');
  });

  it('GET /:id 两源都未命中 → 404', async () => {
    const res = await invokeGetById('nope');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('export 透传 actorType；source=proposal 时走提案源', async () => {
    const layer = (router as any).stack.find(
      (l: any) => l.route && l.route.path === '/export' && l.route.methods.get,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    mockAuditExport.mockResolvedValue([opRow]);
    const res1 = createRes();
    await handler(createReq({ actorType: 'human' }, '/export'), res1, () => undefined);
    expect(mockAuditExport.mock.calls[0][0].actorType).toBe('human');

    vi.clearAllMocks();
    mockQueryProposalRows.mockResolvedValue([propRow]);
    const res2 = createRes();
    await handler(createReq({ source: 'proposal' }, '/export'), res2, () => undefined);
    expect(mockAuditExport).not.toHaveBeenCalled();
    expect(res2.json.mock.calls[0][0]).toEqual([propRow]);
  });
});
