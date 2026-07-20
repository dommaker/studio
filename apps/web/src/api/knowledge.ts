// Knowledge Service API — 2026-07 知识审核闭环
// 待审列表数据源：GET /knowledge-service/entries?maturity=draft（与 audit.byMaturity.draft 同库口径）
// approve → POST /knowledge-service/promote（draft→verified，参与注入）
// reject  → POST /knowledge-service/demote（draft→archived）
import { api } from './index';

export interface KnowledgeEntryItem {
  id: string;
  title: string;
  type?: string;
  maturity?: string;
  created?: string;
  tags?: string[];
}

export const knowledgeApi = {
  /** proposal 待审列表（maturity=draft，按服务端默认排序） */
  listPendingReview: (limit = 50) =>
    api.get<{ entries: KnowledgeEntryItem[]; total: number }>('/knowledge-service/entries', {
      params: { maturity: 'draft', limit },
    }),
  promote: (entryId: string) => api.post('/knowledge-service/promote', { entryId }),
  demote: (entryId: string) => api.post('/knowledge-service/demote', { entryId }),
};
