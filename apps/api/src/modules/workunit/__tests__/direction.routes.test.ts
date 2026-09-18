// #567：POST /:id/direction 路由——方向锁定结构化提交（human-only，仿 /:id/ruling 通道）。
// WorkUnitService mock 掉（形态照 ruling.routes.test.ts）；plan-direction 模块只 mock
// applyPlanDirection（落账+复活属服务层，单测见 pmo/__tests__/plan-direction.test.ts），
// validateDirectionPick/PlanDirectionError 用真身测路由层 400 契约。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockGetById, mockApplyPlanDirection } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockApplyPlanDirection: vi.fn(),
}));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    getById = mockGetById;
  },
  ANALYSIS_TASKS_MAX: 8,
}));

vi.mock('../../pmo/plan-direction.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../pmo/plan-direction.js')>();
  return { ...orig, applyPlanDirection: mockApplyPlanDirection };
});

import router from '../workunit.routes.js';

const DIRECTIONS = {
  question: '自研还是引入依赖？',
  options: [
    { name: '自研', summary: '自研调度内核', tradeoffs: '可控但慢', impact: '触及 scheduler 模块', recommended: true },
    { name: '引入依赖', summary: '引入 bullmq', tradeoffs: '快但多一个依赖', impact: '触及 api 与 daemon', recommended: false },
  ],
};

const BLOCKED_DIRECTION_WU = {
  id: 'wu-1',
  status: 'blocked',
  metadata: JSON.stringify({
    pmoId: 'proj-1',
    waitingForInput: true,
    waitingReason: 'plan-direction',
    planDirections: DIRECTIONS,
  }),
};

describe('#567 POST /workunits/:id/direction（方向锁定提交）', () => {
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
    return fetch(`${base}/${id}/direction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it('200：blocked + 待选 planDirections + 合法 choice → applyPlanDirection 被调并返回更新后 WU', async () => {
    mockGetById.mockResolvedValue(BLOCKED_DIRECTION_WU);
    mockApplyPlanDirection.mockResolvedValue({ ...BLOCKED_DIRECTION_WU, status: 'active' });

    const res = await post('wu-1', { choice: '自研', note: '要可控' });
    expect(res.status).toBe(200);
    expect(mockApplyPlanDirection).toHaveBeenCalledWith('wu-1', { choice: '自研', note: '要可控' }, expect.anything());
    const body = await res.json();
    expect(body.status).toBe('active');
  });

  it('404：WU 不存在', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await post('wu-x', { choice: '自研' });
    expect(res.status).toBe(404);
  });

  it('409：非 blocked / 无待选 planDirections', async () => {
    mockGetById.mockResolvedValue({ ...BLOCKED_DIRECTION_WU, status: 'active' });
    expect((await post('wu-1', { choice: '自研' })).status).toBe(409);

    mockGetById.mockResolvedValue({ ...BLOCKED_DIRECTION_WU, metadata: JSON.stringify({ waitingForInput: true }) });
    expect((await post('wu-1', { choice: '自研' })).status).toBe(409);
  });

  it('400：载荷非法（缺 choice / choice 不在候选内 / 非对象）', async () => {
    mockGetById.mockResolvedValue(BLOCKED_DIRECTION_WU);
    mockApplyPlanDirection.mockClear();
    expect((await post('wu-1', {})).status).toBe(400);
    expect((await post('wu-1', { choice: '第三条路' })).status).toBe(400);
    expect((await post('wu-1', { note: '只有说明' })).status).toBe(400);
    expect(mockApplyPlanDirection).not.toHaveBeenCalled();
  });
});
