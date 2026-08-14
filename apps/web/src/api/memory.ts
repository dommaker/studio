// Role memory review API — #101 角色记忆人审闸口
// memory_proposal 卡 approve → POST /role-memory/promote（草稿 → topic/索引）
//               reject  → POST /role-memory/demote（草稿 → rejected 墓碑）
import { api } from './index';

export const memoryApi = {
  promote: (roleId: string, entryIds: string[]) =>
    api.post('/role-memory/promote', { roleId, entryIds }),
  demote: (roleId: string, entryIds: string[]) =>
    api.post('/role-memory/demote', { roleId, entryIds }),
};
