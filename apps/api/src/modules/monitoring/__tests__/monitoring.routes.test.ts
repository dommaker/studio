// Contract test: Monitoring Routes — MVP-2 + MVP-6
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetAgentSummary, mockGetStats } = vi.hoisted(() => ({
  mockGetAgentSummary: vi.fn().mockResolvedValue({
    agents: [{ id: 'inst-1', name: 'test-agent', status: 'idle', currentWorkUnitId: null, startedAt: '2026-01-01T00:00:00Z' }],
    summary: { total: 1, idle: 1, active: 0, terminated: 0 },
  }),
  mockGetStats: vi.fn().mockResolvedValue({
    workunits: { total: 5, unassigned: 2, active: 1, in_review: 1, done: 1, blocked: 0, closed: 0 },
    agents: { total: 1, idle: 1, active: 0, terminated: 0 },
    recent: { completedLast24h: 1, failedLast24h: 0 },
  }),
}));

vi.mock('../monitoring.service.js', () => ({
  MonitoringService: vi.fn().mockImplementation(() => ({
    getAgentSummary: mockGetAgentSummary,
    getStats: mockGetStats,
  })),
}));

import router from '../monitoring.routes.js';

function mockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (data: any) => { res.body = data; return res; };
  return res;
}

describe('Monitoring Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /agents returns agent summary', async () => {
    const req = {} as any;
    const res = mockRes();
    const handler = router.stack.find((l: any) => l.route?.path === '/agents')?.route?.stack[0]?.handle;
    await handler!(req, res, () => {});
    expect(res.statusCode).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.summary.total).toBe(1);
  });

  it('GET /stats returns monitoring stats', async () => {
    const req = {} as any;
    const res = mockRes();
    const handler = router.stack.find((l: any) => l.route?.path === '/stats')?.route?.stack[0]?.handle;
    await handler!(req, res, () => {});
    expect(res.statusCode).toBe(200);
    expect(res.body.workunits.total).toBe(5);
    expect(res.body.agents.total).toBe(1);
    expect(res.body.recent.completedLast24h).toBe(1);
  });

  it('GET /agents returns 500 on service error', async () => {
    mockGetAgentSummary.mockRejectedValueOnce(new Error('DB error'));
    const req = {} as any;
    const res = mockRes();
    const handler = router.stack.find((l: any) => l.route?.path === '/agents')?.route?.stack[0]?.handle;
    await handler!(req, res, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
