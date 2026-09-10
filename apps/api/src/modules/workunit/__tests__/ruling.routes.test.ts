// #467：POST /:id/ruling 路由——裁决轮结构化提交（human-only，仿 /:id/resume 通道）。
// WorkUnitService mock 掉（形态照 review-confirm.routes.test.ts）；plan-ruling 模块只 mock
// applyPlanRuling（落账+复活属服务层，单测见 pmo/__tests__/plan-ruling.test.ts），
// validateRulingItems/PlanRulingError 用真身测路由层 400 契约。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockGetById, mockApplyPlanRuling } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockApplyPlanRuling: vi.fn(),
}));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    getById = mockGetById;
  },
  ANALYSIS_TASKS_MAX: 8,
}));

vi.mock('../../pmo/plan-ruling.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../pmo/plan-ruling.js')>();
  return { ...orig, applyPlanRuling: mockApplyPlanRuling };
});

import router from '../workunit.routes.js';

const BLOCKED_RULING_WU = {
  id: 'wu-1',
  status: 'blocked',
  metadata: JSON.stringify({
    pmoId: 'proj-1',
    waitingForInput: true,
    waitingReason: 'plan-ruling',
    planRulings: [{ question: '存储选型？', suggestion: 'SQLite' }],
  }),
};

describe('#467 POST /workunits/:id/ruling（裁决轮提交）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/workunits', router);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}/workunits`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  function post(id: string, body?: unknown) {
    return fetch(`${base}/${id}/ruling`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it('200：blocked + 待裁 rulings + 合法 items → applyPlanRuling 被调并返回更新后 WU', async () => {
    mockGetById.mockResolvedValue(BLOCKED_RULING_WU);
    mockApplyPlanRuling.mockResolvedValue({ ...BLOCKED_RULING_WU, status: 'active' });

    const items = [{ question: '存储选型？', action: 'accept', conclusion: 'SQLite' }];
    const res = await post('wu-1', { items });
    expect(res.status).toBe(200);
    expect(mockApplyPlanRuling).toHaveBeenCalledWith('wu-1', items, expect.anything());
    const body = await res.json();
    expect(body.status).toBe('active');
  });

  it('404：WU 不存在', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await post('wu-x', { items: [{ question: 'q', action: 'reopen' }] });
    expect(res.status).toBe(404);
  });

  it('409：非 blocked / 无待裁 rulings', async () => {
    mockGetById.mockResolvedValue({ ...BLOCKED_RULING_WU, status: 'active' });
    expect((await post('wu-1', { items: [{ question: 'q', action: 'reopen' }] })).status).toBe(409);

    mockGetById.mockResolvedValue({ ...BLOCKED_RULING_WU, metadata: JSON.stringify({ waitingForInput: true }) });
    expect((await post('wu-1', { items: [{ question: 'q', action: 'reopen' }] })).status).toBe(409);
  });

  it('400：载荷非法（缺 items / 采纳缺结论 / 未知 action）', async () => {
    mockGetById.mockResolvedValue(BLOCKED_RULING_WU);
    mockApplyPlanRuling.mockClear();
    expect((await post('wu-1', {})).status).toBe(400);
    expect((await post('wu-1', { items: [{ question: 'q', action: 'accept' }] })).status).toBe(400);
    expect((await post('wu-1', { items: [{ question: 'q', action: 'maybe' }] })).status).toBe(400);
    expect(mockApplyPlanRuling).not.toHaveBeenCalled();
  });
});
