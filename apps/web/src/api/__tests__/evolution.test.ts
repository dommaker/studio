// Contract test: Evolution proposal review API client — #623 断点 3 遗留补丁（通用端点 kind='evolution'）
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../index', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: { success: true, status: 'pending' } }),
  },
}));

import { evolutionApi } from '../evolution';
import { api } from '../index';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('evolutionApi（通用端点 /review-proposals/evolution/:id/{approve,reject,status}）', () => {
  it('approve calls POST /review-proposals/evolution/:id/approve', async () => {
    await evolutionApi.approve('EP-0001');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/evolution/EP-0001/approve');
  });

  it('reject calls POST /review-proposals/evolution/:id/reject', async () => {
    await evolutionApi.reject('EP-0001');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/evolution/EP-0001/reject');
  });

  it('proposalStatus GET status（id 编码）', async () => {
    const { data } = await evolutionApi.proposalStatus('EP 1');
    expect(api.get).toHaveBeenCalledWith('/review-proposals/evolution/EP%201/status');
    expect(data.status).toBe('pending');
  });
});
