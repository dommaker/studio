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

vi.mock('@dommaker/studio-audit', () => ({
  AuditService: vi.fn().mockImplementation(function () {
    return { query: mockAuditQuery };
  }),
  AuditActions: { LOGIN: 'login' },
  AuditResources: { USER: 'user' },
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
