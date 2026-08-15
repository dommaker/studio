// Contract test: Distill review API client — #143 蒸馏提案人审闸口
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: { post: vi.fn().mockResolvedValue({ data: {} }), get: vi.fn().mockResolvedValue({ data: {} }) },
}));

import { distillApi } from '../distill';
import { api } from '../index';

describe('distillApi', () => {
  it('approve calls POST /distill/approve with {proposalId}', async () => {
    await distillApi.approve('dp-1');
    expect(api.post).toHaveBeenCalledWith('/distill/approve', { proposalId: 'dp-1' });
  });

  it('reject calls POST /distill/reject with {proposalId}', async () => {
    await distillApi.reject('dp-1');
    expect(api.post).toHaveBeenCalledWith('/distill/reject', { proposalId: 'dp-1' });
  });

  it('proposalStatus calls GET /distill/proposal-status with comma-separated ids', async () => {
    await distillApi.proposalStatus(['dp-1', 'dp 2']);
    expect(api.get).toHaveBeenCalledWith('/distill/proposal-status?ids=dp-1,dp%202');
  });
});
