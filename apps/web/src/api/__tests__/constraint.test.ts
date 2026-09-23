// Contract test: Constraint proposal review API client — ADR-0033 子项 7/8 通用端点 kind='constraint'
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../index', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: { success: true, status: 'pending' } }),
  },
}));

import { constraintApi } from '../constraint';
import { api } from '../index';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('constraintApi（通用端点 /review-proposals/constraint/:id/{approve,reject,status}）', () => {
  it('approve calls POST /review-proposals/constraint/:id/approve', async () => {
    await constraintApi.approve('cp-1');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/constraint/cp-1/approve');
  });

  it('reject calls POST /review-proposals/constraint/:id/reject', async () => {
    await constraintApi.reject('cp-1');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/constraint/cp-1/reject');
  });

  it('proposalStatus GET status（id 编码）', async () => {
    const { data } = await constraintApi.proposalStatus('cp 1');
    expect(api.get).toHaveBeenCalledWith('/review-proposals/constraint/cp%201/status');
    expect(data.status).toBe('pending');
  });
});
