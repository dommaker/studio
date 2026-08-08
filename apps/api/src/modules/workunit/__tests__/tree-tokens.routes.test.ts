/**
 * GET /:id/tree-tokens - 树级 token 开销聚合接口测试（AC-5.4）
 *
 * 覆盖：
 *  - 404：WU 不存在
 *  - 200：返回 TreeTokenReport 结构（rootId / nodes / rootTotal / budgetRemaining）
 *  - 200：无 collab metadata 时 rootId = WU 自身 id
 *  - 200：有 collab.rootId 时 rootId 从 metadata 取
 *  - 500：aggregateTreeTokens 抛错时返回 INTERNAL_ERROR
 *
 * 路由层契约测试，mock WorkUnitService + aggregateTreeTokens（同 workunit-evidence.routes.test.ts 模式）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockGetById } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
}));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    getById = mockGetById;
  },
}));

const { mockAggregateTreeTokens } = vi.hoisted(() => ({
  mockAggregateTreeTokens: vi.fn(),
}));

vi.mock('../../agents/token-usage.service.js', () => ({
  aggregateTreeTokens: mockAggregateTreeTokens,
}));

vi.mock('../../agents/loop/wu-verification.js', () => ({
  CODE_WORKTREE_TYPES: new Set(['task', 'bug', 'feature', 'refactor']),
  resolveVerifyCommands: vi.fn(),
  runWuVerification: vi.fn(),
}));

vi.mock('../../agents/loop/review-dispatcher.js', () => ({
  getReviewDispatcher: () => ({ dispatchReviewNow: vi.fn() }),
}));

import router from '../workunit.routes.js';

describe('GET /:id/tree-tokens (AC-5.4)', () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function get(p: string): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${p}`);
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  it('404：WU 不存在', async () => {
    mockGetById.mockResolvedValue(null);

    const res = await get('/nonexistent-wu/tree-tokens');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('NOT_FOUND');
  });

  it('200：无 collab metadata 时 rootId = WU 自身 id', async () => {
    const wu = { id: 'wu-1', metadata: null };
    mockGetById.mockResolvedValue(wu);
    const report = {
      rootId: 'wu-1',
      nodes: [],
      rootTotal: 0,
      budgetRemaining: 100000,
    };
    mockAggregateTreeTokens.mockResolvedValue(report);

    const res = await get('/wu-1/tree-tokens');
    expect(res.status).toBe(200);
    expect(res.json.rootId).toBe('wu-1');
    expect(res.json.nodes).toEqual([]);
    expect(res.json.rootTotal).toBe(0);
    expect(res.json.budgetRemaining).toBe(100000);
    // rootId 从 wu.id 取（metadata null）
    expect(mockAggregateTreeTokens).toHaveBeenCalledWith('wu-1', expect.anything());
  });

  it('200：有 collab.rootId 时 rootId 从 metadata 取', async () => {
    const wu = {
      id: 'wu-child-1',
      metadata: JSON.stringify({ collab: { rootId: 'wu-root' } }),
    };
    mockGetById.mockResolvedValue(wu);
    const report = {
      rootId: 'wu-root',
      nodes: [
        {
          workUnitId: 'wu-root',
          profileName: 'Analyst',
          status: 'done',
          injectedTokens: 5000,
          executionTokens: 10000,
          totalTokens: 15000,
        },
      ],
      rootTotal: 10000,
      budgetRemaining: 90000,
    };
    mockAggregateTreeTokens.mockResolvedValue(report);

    const res = await get('/wu-child-1/tree-tokens');
    expect(res.status).toBe(200);
    expect(res.json.rootId).toBe('wu-root');
    expect(res.json.nodes).toHaveLength(1);
    expect(res.json.nodes[0].profileName).toBe('Analyst');
    expect(res.json.rootTotal).toBe(10000);
    // rootId 从 metadata.collab.rootId 取
    expect(mockAggregateTreeTokens).toHaveBeenCalledWith('wu-root', expect.anything());
  });

  it('500：aggregateTreeTokens 抛错时返回 INTERNAL_ERROR', async () => {
    const wu = { id: 'wu-2', metadata: null };
    mockGetById.mockResolvedValue(wu);
    mockAggregateTreeTokens.mockRejectedValue(new Error('scan failed'));

    const res = await get('/wu-2/tree-tokens');
    expect(res.status).toBe(500);
    expect(res.json.error.code).toBe('INTERNAL_ERROR');
  });
});
