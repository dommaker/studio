// Role memory review API — #101 角色记忆人审闸口
// memory_proposal 卡 approve → POST /role-memory/promote（草稿 → topic/索引）
//               reject  → POST /role-memory/demote（草稿 → rejected 墓碑）
// 刷新后已审态派生   → GET  /role-memory/draft-status（按草稿墓碑状态）
import { api } from './index';

/** 草稿条目审核状态（与 API MemoryDraftStatus 对齐） */
export type MemoryDraftStatus = 'pending' | 'promoted' | 'rejected' | 'unknown';

export const memoryApi = {
  promote: (roleId: string, entryIds: string[]) =>
    api.post('/role-memory/promote', { roleId, entryIds }),
  demote: (roleId: string, entryIds: string[]) =>
    api.post('/role-memory/demote', { roleId, entryIds }),
  draftStatus: (roleId: string, entryIds: string[]) =>
    api.get<{ success: boolean; statuses: Record<string, MemoryDraftStatus> }>(
      `/role-memory/draft-status?roleId=${encodeURIComponent(roleId)}&ids=${entryIds.map(encodeURIComponent).join(',')}`,
    ),
};
