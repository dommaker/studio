/**
 * #359: PMO GET /project 分页 limit 统一走 parsePagination（clamp 1..100）
 *
 * 修复前 `parseInt(req.query.limit) || 20` 无上限，limit=999999 直通 projectService.list。
 * 缺省值不变（20，与 parsePagination 一致）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockProjectList = vi.hoisted(() => vi.fn());

vi.mock('../project.service.js', () => ({
  projectService: { list: mockProjectList },
  parsePmoNumberFromCommand: vi.fn(),
}));

import router from '../routes.js';

function createReq(query: Record<string, unknown>) {
  return { method: 'GET', url: '/project', headers: {}, query, params: {}, body: {}, get: () => undefined } as any;
}
function createRes() {
  const res: Record<string, any> = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res as any;
}
async function invokeList(query: Record<string, unknown>) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === '/project' && l.route.methods.get,
  );
  const stack = layer.route.stack;
  const handler = stack[stack.length - 1].handle;
  await handler(createReq(query), createRes(), () => undefined);
}

describe('PMO GET /project 分页 clamp (#359)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectList.mockResolvedValue([]);
  });

  it('limit=999999 clamp 到 100，不再直通 service', async () => {
    await invokeList({ limit: '999999' });
    expect(mockProjectList).toHaveBeenCalledTimes(1);
    expect(mockProjectList.mock.calls[0][0].limit).toBe(100);
  });

  it('缺省 limit=20（与既有口径一致）', async () => {
    await invokeList({});
    expect(mockProjectList.mock.calls[0][0].limit).toBe(20);
  });
});
