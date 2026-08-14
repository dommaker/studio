// Contract test: Role memory review API client — #101 角色记忆人审闸口
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: { post: vi.fn().mockResolvedValue({ data: {} }) },
}));

import { memoryApi } from '../memory';
import { api } from '../index';

describe('memoryApi', () => {
  it('promote calls POST /role-memory/promote with {roleId, entryIds}', async () => {
    await memoryApi.promote('role-1', ['d-1', 'd-2']);
    expect(api.post).toHaveBeenCalledWith('/role-memory/promote', { roleId: 'role-1', entryIds: ['d-1', 'd-2'] });
  });

  it('demote calls POST /role-memory/demote with {roleId, entryIds}', async () => {
    await memoryApi.demote('role-1', ['d-1']);
    expect(api.post).toHaveBeenCalledWith('/role-memory/demote', { roleId: 'role-1', entryIds: ['d-1'] });
  });
});
