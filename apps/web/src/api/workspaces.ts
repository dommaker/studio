// Workspace API — AS-020 P2/P7（P3-a 自 api/index.ts 拆出）
// 契约驱动迁移（2026-10 批次 2/7）：响应统一 { data } 壳（原 { success, data, total }，total 退役）。
import type { Workspace } from '@dommaker/studio-contract';
import { api } from './client';

export type { Workspace };

export const workspaceApi = {
  list: () => api.get<{ data: Workspace[] }>('/workspaces'),
  get: (id: string) => api.get<{ data: Workspace }>(`/workspaces/${id}`),
};
