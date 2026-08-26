// Contract test: Auditor suggestion review API client — #356 通用端点（review-proposal 正本，kind='auditor'）
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: { success: true, status: 'pending' } }),
  },
}));

import { auditorApi } from '../auditor';
import { api } from '../index';

describe('auditorApi（#356 通用端点）', () => {
  it('approveProposal calls POST /review-proposals/auditor/:proposalId/approve', async () => {
    await auditorApi.approveProposal('ap-1');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/auditor/ap-1/approve');
  });

  it('rejectProposal calls POST /review-proposals/auditor/:proposalId/reject', async () => {
    await auditorApi.rejectProposal('ap-2');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/auditor/ap-2/reject');
  });

  it('proposalStatus calls GET /review-proposals/auditor/:proposalId/status（id 编码）', async () => {
    await auditorApi.proposalStatus('ap/3');
    expect(api.get).toHaveBeenCalledWith('/review-proposals/auditor/ap%2F3/status');
  });
});
