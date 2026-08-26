// Contract test: Distill review API client — #351 人审提案卡通用端点
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../index', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: { success: true, status: 'pending' } }),
  },
}));

import { distillApi } from '../distill';
import { api } from '../index';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('distillApi（通用端点 /review-proposals/:kind/:id/{approve,reject,status}）', () => {
  it('approve calls POST /review-proposals/distill/:id/approve', async () => {
    await distillApi.approve('dp-1');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/distill/dp-1/approve');
  });

  it('reject calls POST /review-proposals/distill/:id/reject', async () => {
    await distillApi.reject('dp-1');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/distill/dp-1/reject');
  });

  it('proposalStatus 按 id 逐个 GET status 并合并 statuses map（id 编码）', async () => {
    const { data } = await distillApi.proposalStatus(['dp-1', 'dp 2']);
    expect(api.get).toHaveBeenCalledWith('/review-proposals/distill/dp-1/status');
    expect(api.get).toHaveBeenCalledWith('/review-proposals/distill/dp%202/status');
    expect(data.statuses).toEqual({ 'dp-1': 'pending', 'dp 2': 'pending' });
  });

  it('gcApprove/gcReject/gcProposalStatus 走 kind=gc', async () => {
    await distillApi.gcApprove('gc-1');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/gc/gc-1/approve');
    await distillApi.gcReject('gc-1');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/gc/gc-1/reject');
    await distillApi.gcProposalStatus(['gc-1']);
    expect(api.get).toHaveBeenCalledWith('/review-proposals/gc/gc-1/status');
  });

  it('auditApprove/auditReject/auditProposalStatus 走 kind=audit', async () => {
    await distillApi.auditApprove('audit-1');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/audit/audit-1/approve');
    await distillApi.auditReject('audit-1');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/audit/audit-1/reject');
    await distillApi.auditProposalStatus(['audit-1']);
    expect(api.get).toHaveBeenCalledWith('/review-proposals/audit/audit-1/status');
  });
});
