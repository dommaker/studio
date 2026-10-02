// Library API (#155 T5: 阅览室——跨项目 .studio/ 聚合只读层；无写路径)
// P3-a 自 api/index.ts 拆出。
// 契约驱动迁移（2026-10 批次 4/7）：类型 import 自 contract；响应统一 `{ data }` 壳
// （原 `{ success, data }` 壳的 success 标志退役——res.data.data 读取两形态兼容，不变）。
import type { LibraryListItem, LibraryDocDetail } from '@dommaker/studio-contract';
import { api } from './client';

export type { LibraryListItem, LibraryDocDetail };

export const libraryApi = {
  list: (params?: { search?: string; project?: string }) =>
    api.get<{ data: LibraryListItem[] }>('/library', { params }),
  getDoc: (id: string) =>
    api.get<{ data: LibraryDocDetail }>(`/library/${encodeURIComponent(id)}`),
};
