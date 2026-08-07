/**
 * POST /maintenance/run — F1 知识库维护手动触发端点测试
 *
 * 手动触发绕过 B7 开关（knowledgeMaintenanceEnabled 只管 MonitorService 自动日循环），
 * 端点直接调 knowledgeCurator.runDailyMaintenance 并返回聚合结果；服务异常 → 500。
 *
 * 路由层契约测试，mock knowledge-curator.service（同 tree-tokens.routes.test.ts 模式）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockRunDailyMaintenance } = vi.hoisted(() => ({
  mockRunDailyMaintenance: vi.fn(),
}));

vi.mock('../../agents/knowledge/knowledge-curator.service.js', () => ({
  knowledgeCurator: { runDailyMaintenance: mockRunDailyMaintenance },
}));

import { maintenanceRoutes } from '../maintenance.routes.js';

describe('POST /maintenance/run（F1 手动触发）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/knowledge', maintenanceRoutes);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}/knowledge`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('调用 runDailyMaintenance 并返回聚合结果', async () => {
    mockRunDailyMaintenance.mockResolvedValue({
      dedupMerged: 2, qualityArchived: 1, freshnessUpdated: 0, contradictionsResolved: 3,
    });

    const res = await fetch(`${base}/maintenance/run`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ dedupMerged: 2, qualityArchived: 1, freshnessUpdated: 0, contradictionsResolved: 3 });
    expect(mockRunDailyMaintenance).toHaveBeenCalledTimes(1);
  });

  it('服务层抛错 → 500 + message', async () => {
    mockRunDailyMaintenance.mockRejectedValue(new Error('executor down'));

    const res = await fetch(`${base}/maintenance/run`, { method: 'POST' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain('executor down');
  });
});
