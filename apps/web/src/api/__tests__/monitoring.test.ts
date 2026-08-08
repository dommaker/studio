// Contract test: Monitoring API client — MVP-2 + MVP-6
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { monitoringApi } from '../monitoring';
import { api } from '../index';

describe('monitoringApi', () => {
  it('getAgentSummary calls GET /monitoring/agents', async () => {
    await monitoringApi.getAgentSummary();
    expect(api.get).toHaveBeenCalledWith('/monitoring/agents');
  });

  it('getStats calls GET /monitoring/stats', async () => {
    await monitoringApi.getStats();
    expect(api.get).toHaveBeenCalledWith('/monitoring/stats');
  });

  it('terminateInstance calls POST /agent-instances/:id/terminate', async () => {
    await monitoringApi.terminateInstance('i1');
    expect(api.post).toHaveBeenCalledWith('/agent-instances/i1/terminate');
  });
});
