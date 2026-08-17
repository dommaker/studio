// Knowledge API — 知识审核闭环 + 知识库浏览：
// 1) 知识审核闭环（2026-07）：GET /knowledge-service/entries?maturity=draft（与 audit.byMaturity.draft 同库口径）
//    approve → POST /knowledge-service/promote（draft→verified，参与注入）
//    reject  → POST /knowledge-service/demote（draft→archived）
// 2) 知识库浏览（KnowledgePage）：listResolutions/listGaps/listUnified/createUnifiedEntry/search
//
// #149（2026-08-15）：document-store 退役——项目文档接口（listByProject/getDetail/archive）
// 与冷启动导入（importScan/importExecute）已随后端 documents/import 路由一并摘除。
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
  /** 单条目查询（卡片已审核态按 maturity 派生的数据源） */
  getEntry: (id: string) => api.get<KnowledgeEntryItem>(`/knowledge-service/entries/${id}`),

  /** 解法库浏览（KnowledgePage 解法库 tab；pending + canonical 口径） */
  listResolutions: () =>
    api.get<{ resolutions: ResolutionItem[]; total: number; byStatus: Record<string, number> }>(
      '/knowledge/resolutions'
    ),

  /** 五类知识缺口查询（KnowledgePage 偏好/规则/环境/决策链/交互 tab） */
  listGaps: (type: KnowledgeGapType) =>
    api.get<{ type: string; data: unknown[]; total: number }>(`/knowledge/gaps/${type}`),

  /** 统一知识浏览（AS-022，KnowledgePage 统一视图 tab） */
  listUnified: (params?: { limit?: number; offset?: number; consumptionMode?: string }) =>
    api.get<{ entries: UnifiedEntry[]; total: number }>('/knowledge/unified', { params }),

  /** 手动创建知识条目（AS-022；requireAuth + requireNotGuest） */
  createUnifiedEntry: (data: {
    type: string;
    title: string;
    content: string;
    consumptionMode: string;
    tags?: string[];
    applicableAgents?: string[];
  }) => api.post('/knowledge/unified', data),

  /** 全局搜索（S11：resolution/pattern/knowledge 混合结果，按 score 倒序） */
  search: (q: string) =>
    api.get<{ results: KnowledgeSearchResult[] }>('/knowledge/search', { params: { q } }),
};

/** 解法库条目（GET /knowledge/resolutions；只声明 ResolutionCard 消费字段） */
export interface ResolutionItem {
  id: string;
  title: string;
  status?: string;
  layer?: string;
  pattern?: string;
  fix?: string;
  /** 后端可能双重编码为 JSON 字符串，消费方容错解析 */
  tags?: string[] | string;
  errorClass?: string;
  sourceGoalId?: string;
  verifyCount?: number;
}

/** 知识缺口类型（/knowledge/gaps/:type 的合法值，服务端 400 校验） */
export type KnowledgeGapType =
  | 'preference'
  | 'business_rule'
  | 'environment'
  | 'decision_chain'
  | 'interaction';

/** 统一知识条目（GET /knowledge/unified 的 entries 元素） */
export interface UnifiedEntry {
  id: string;
  title: string;
  content?: string;
  consumptionMode?: string;
  source?: string;
  tags?: string[];
}

/** 全局搜索结果条目（GET /knowledge/search 的 results 元素） */
export interface KnowledgeSearchResult {
  type: string;
  id: string;
  title: string;
  snippet: string;
  score: number;
}
