// Contract test: Role memory review API client — #353 通用端点（review-proposal 正本，kind='memory'）
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: { success: true, status: 'pending' } }),
  },
}));

import { memoryApi } from '../memory';
import { api } from '../index';

describe('memoryApi（#353 通用端点）', () => {
  it('approve calls POST /review-proposals/memory/:draftId/approve', async () => {
    await memoryApi.approve('d-1');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/memory/d-1/approve');
  });

  it('reject calls POST /review-proposals/memory/:draftId/reject', async () => {
    await memoryApi.reject('d-2');
    expect(api.post).toHaveBeenCalledWith('/review-proposals/memory/d-2/reject');
  });

  it('status 逐 id 查通用端点并合并 statuses map', async () => {
    // 契约驱动迁移（批次 4/7）：status 响应 `{ data: { status } }` 壳
    vi.mocked(api.get)
      .mockResolvedValueOnce({ data: { data: { status: 'executed' } } } as never)
      .mockResolvedValueOnce({ data: { data: { status: 'rejected' } } } as never);
    const { data } = await memoryApi.status(['d-1', 'd-2']);
    expect(api.get).toHaveBeenCalledWith('/review-proposals/memory/d-1/status');
    expect(api.get).toHaveBeenCalledWith('/review-proposals/memory/d-2/status');
    expect(data.statuses).toEqual({ 'd-1': 'executed', 'd-2': 'rejected' });
  });
});
