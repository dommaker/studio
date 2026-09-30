// Contract test: Evolution proposal review API client — #623 断点 3 遗留补丁（通用端点 kind='evolution'）
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../index', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    // 契约驱动迁移（批次 4/7）：status 响应 `{ data: { status } }` 壳
    get: vi.fn().mockResolvedValue({ data: { data: { status: 'pending' } } }),
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
    // 契约驱动迁移（批次 4/7）：`{ data: { status } }` 壳（success 标志退役）
    expect(data.data.status).toBe('pending');
  });
});
