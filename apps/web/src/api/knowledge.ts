// Knowledge API — 知识审核闭环 + 知识库浏览：
// 1) 知识审核闭环（2026-07）：GET /knowledge-service/entries?maturity=draft（与 audit.byMaturity.draft 同库口径）
//    knowledge_proposal 卡审批（#355 起走 review-proposal 正本通用端点，kind='knowledge'）：
//    approve → POST /review-proposals/knowledge/:proposalId/approve（adapter 逐条目 promote，draft→verified）
//    reject  → POST /review-proposals/knowledge/:proposalId/reject（adapter 逐条目 demote，draft→archived）
//    刷新后已审态派生 → GET /review-proposals/knowledge/:proposalId/status
//    promote/demote 为条目生命周期端点（MonitoringPage 人工 promote 等非提案场景在用），保留。
// 2) 知识库浏览（KnowledgePage）：listResolutions/listGaps/listUnified/createUnifiedEntry/search
//
// #149（2026-08-15）：document-store 退役——项目文档接口（listByProject/getDetail/archive）
// 与冷启动导入（importScan/importExecute）已随后端 documents/import 路由一并摘除。
//
// 契约驱动迁移（2026-10 批次 4/7）：手抄 interface（KnowledgeEntryItem/
// ResolutionItem/KnowledgeGapType/UnifiedEntry/KnowledgeSearchResult/提案状态词表）
// 删除改 contract import；响应统一 `{ data }` 壳（原平铺），消费方解包
// res.data → res.data.data。KnowledgePage 的 15 处直接调用只收口类型与解包，
// 数据获取范式统一归 Phase 3。
import type {
  KnowledgeEntryItem,
  Resolution,
  KnowledgeGapType,
  UnifiedKnowledgeEntry,
  KnowledgeSearchResult,
  KnowledgeGapsResult,
  UnifiedKnowledgeListResult,
  ResolutionListResult,
  KnowledgeSearchListResult,
  KnowledgeEntryListResult,
  CreateUnifiedEntryResult,
  ReviewProposalApproveResult,
  ReviewProposalStatusResult,
  KnowledgeSuccessResult,
} from '@dommaker/studio-contract';
import { api } from './index';

export type { KnowledgeEntryItem, KnowledgeGapType, UnifiedKnowledgeEntry, KnowledgeSearchResult };
/** 解法库条目（GET /knowledge/resolutions）——契约 Resolution（tags 可能双重编码为 JSON 串，消费方容错解析） */
export type ResolutionItem = Resolution;
/** 统一知识条目（GET /knowledge/unified 的 entries 元素） */
export type UnifiedEntry = UnifiedKnowledgeEntry;
/** 提案状态（与 review-proposal 正本状态词表对齐；unknown = 查无此提案） */
export type KnowledgeProposalStatus = ReviewProposalStatusResult['status'];

export const knowledgeApi = {
  /** proposal 待审列表（maturity=draft，按服务端默认排序） */
  listPendingReview: (limit = 50) =>
    api.get<{ data: KnowledgeEntryListResult }>('/knowledge-service/entries', {
      params: { maturity: 'draft', limit },
    }),
  promote: (entryId: string) =>
    api.post<{ data: KnowledgeSuccessResult }>('/knowledge-service/promote', { entryId }),
  demote: (entryId: string) =>
    api.post<{ data: KnowledgeSuccessResult }>('/knowledge-service/demote', { entryId }),
  /** knowledge_proposal 卡审批（通用端点，proposalId 取自 cardData） */
  approveProposal: (proposalId: string) =>
    api.post<{ data: ReviewProposalApproveResult & { promoted?: number } }>(
      `/review-proposals/knowledge/${encodeURIComponent(proposalId)}/approve`,
    ),
  rejectProposal: (proposalId: string) =>
    api.post(`/review-proposals/knowledge/${encodeURIComponent(proposalId)}/reject`),
  proposalStatus: (proposalId: string) =>
    api.get<{ data: ReviewProposalStatusResult }>(
      `/review-proposals/knowledge/${encodeURIComponent(proposalId)}/status`,
    ),

  /** 解法库浏览（KnowledgePage 解法库 tab；draft + proven 口径） */
  listResolutions: () =>
    api.get<{ data: ResolutionListResult }>('/knowledge/resolutions'),

  /** 五类知识缺口查询（KnowledgePage 偏好/规则/环境/决策链/交互 tab） */
  listGaps: (type: KnowledgeGapType) =>
    api.get<{ data: KnowledgeGapsResult }>(`/knowledge/gaps/${type}`),

  /** 统一知识浏览（AS-022，KnowledgePage 统一视图 tab；E5 起支持 maturity 过滤——后端 /knowledge/unified 原生参数） */
  listUnified: (params?: { limit?: number; offset?: number; consumptionMode?: string; maturity?: string }) =>
    api.get<{ data: UnifiedKnowledgeListResult }>('/knowledge/unified', { params }),

  /** 手动创建知识条目（AS-022；requireAuth + requireNotGuest） */
  createUnifiedEntry: (data: {
    type: string;
    title: string;
    content: string;
    consumptionMode: string;
    tags?: string[];
    applicableAgents?: string[];
  }) => api.post<{ data: CreateUnifiedEntryResult }>('/knowledge/unified', data),

  /** 全局搜索（S11：resolution/pattern/knowledge 混合结果，按 score 倒序） */
  search: (q: string) =>
    api.get<{ data: KnowledgeSearchListResult }>('/knowledge/search', { params: { q } }),
};
