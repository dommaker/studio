/**
 * #469：POST /pmo/project/:id/mark-delivered 路由层测试
 *
 * branch-only 人工落档入口：commit 非空校验（400）、not-found（404）、
 * not-branch-only / already-delivered（409）、成功（200）。
 * human-only 兜底与 deliver 路由同款（authorType=agent → 403）。
 * service 全分支由 delivery.test.ts 兜底；本文件只测路由映射（直调 handler，同 routes-pagination 先例）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMark = vi.hoisted(() => vi.fn());

vi.mock('../delivery.js', () => ({
  getDeliveryStatus: vi.fn(),
  deliverProject: vi.fn(),
  markProjectDelivered: mockMark,
}));

import router from '../routes.js';

function createReq(body: Record<string, unknown>, headers: Record<string, unknown> = {}) {
  return { method: 'POST', url: '/project/p1/mark-delivered', headers, query: {}, params: { id: 'p1' }, body, get: () => undefined } as any;
}
function createRes() {
  const res: Record<string, any> = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res as any;
}
async function invoke(body: Record<string, unknown>, headers: Record<string, unknown> = {}) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === '/project/:id/mark-delivered' && l.route.methods.post,
  );
  const stack = layer.route.stack;
  const handler = stack[stack.length - 1].handle;
  const res = createRes();
  await handler(createReq(body, headers), res, () => undefined);
  return res;
}

describe('POST /pmo/project/:id/mark-delivered（#469）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMark.mockResolvedValue({ marked: true, deliverCommit: 'c0ffee', deliveredAt: '2026-09-09T00:00:00Z' });
  });

  it('commit 缺失/空白 → 400，不进 service', async () => {
    for (const body of [{}, { commit: '' }, { commit: '   ' }, { commit: 123 }]) {
      const res = await invoke(body);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('成功 → 200 + delivered/deliverCommit/deliveredAt；commit trim 后入 service', async () => {
    const res = await invoke({ commit: '  c0ffee  ' });
    expect(mockMark).toHaveBeenCalledWith('p1', expect.any(String), 'c0ffee');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      delivered: true,
      deliverCommit: 'c0ffee',
      deliveredAt: '2026-09-09T00:00:00Z',
    }));
  });

  it('not-found → 404；not-branch-only / already-delivered → 409（code 大写下划线）', async () => {
    mockMark.mockResolvedValueOnce({ marked: false, reason: 'not-found' });
    expect((await invoke({ commit: 'c0ffee' })).status).toHaveBeenCalledWith(404);

    mockMark.mockResolvedValueOnce({ marked: false, reason: 'not-branch-only', detail: 'auto-merge 项目请走交付合并' });
    let res = await invoke({ commit: 'c0ffee' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error.code).toBe('NOT_BRANCH_ONLY');

    mockMark.mockResolvedValueOnce({ marked: false, reason: 'already-delivered', detail: '已落档' });
    res = await invoke({ commit: 'c0ffee' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error.code).toBe('ALREADY_DELIVERED');
  });

  it('authorType=agent → 403（交付权只在人，同 deliver 路由）', async () => {
    const res = await invoke({ commit: 'c0ffee', authorType: 'agent' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockMark).not.toHaveBeenCalled();
  });
});
