// Knowledge API — 两部分：
// 1) 知识审核闭环（2026-07）：GET /knowledge-service/entries?maturity=draft（与 audit.byMaturity.draft 同库口径）
//    approve → POST /knowledge-service/promote（draft→verified，参与注入）
//    reject  → POST /knowledge-service/demote（draft→archived）
// 2) 知识库文档（PMO 驾驶舱文档区 + 抽屉阅读器）：
//    GET /knowledge/:projectId（列表）/ GET /knowledge/detail/:documentId（含 content 详情）
import { api } from './index';

export interface KnowledgeEntryItem {
  id: string;
  title: string;
  type?: string;
  maturity?: string;
  created?: string;
  tags?: string[];
}

/** 知识库文档摘要（列表条目；与后端 DocRecord 对齐，只声明 UI 消费字段） */
export interface KnowledgeDoc {
  id: string;
  projectId: string;
  type: string;          // requirement / design / spec / execution / archive …
  title: string;
  version: number;
  status: string;        // active / archived / draft …
  createdAt?: string;
  updatedAt?: string;
}

/** 文档详情（GET /knowledge/detail/:documentId，比列表多 content） */
export interface KnowledgeDocDetail extends KnowledgeDoc {
  content: string;
  tags?: string[];
  createdBy?: string;
}

/** GET /knowledge/:projectId 响应体（后端直接 res.json，无 success 信封） */
export interface ProjectKnowledgeList {
  documents: KnowledgeDoc[];
  stats?: {
    total: number;
    active: number;
    archived: number;
    byType: Array<{ type: string; count: number }>;
  };
}

export const knowledgeApi = {
  /** proposal 待审列表（maturity=draft，按服务端默认排序） */
  listPendingReview: (limit = 50) =>
    api.get<{ entries: KnowledgeEntryItem[]; total: number }>('/knowledge-service/entries', {
      params: { maturity: 'draft', limit },
    }),
  promote: (entryId: string) => api.post('/knowledge-service/promote', { entryId }),
  demote: (entryId: string) => api.post('/knowledge-service/demote', { entryId }),
  /** 单条目查询（卡片已审核态按 maturity 派生的数据源） */
  getEntry: (id: string) => api.get<KnowledgeEntryItem>(`/knowledge-service/entries/${id}`),

  /** 项目文档列表（PMO 详情页文档区 / PMO 列表页文档计数徽章） */
  listByProject: (projectId: string) =>
    api.get<ProjectKnowledgeList>(`/knowledge/${projectId}`),

  /** 文档详情（抽屉阅读器；此前端接口此前零调用） */
  getDetail: (documentId: string) =>
    api.get<KnowledgeDocDetail>(`/knowledge/detail/${documentId}`),
};
