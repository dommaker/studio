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

  /** 归档单篇文档（PMO 详情页「归档知识库」，human-only） */
  archive: (documentId: string) =>
    api.post(`/knowledge/${documentId}/archive`),

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

  /** 全局搜索（S11：document/resolution/pattern/knowledge 混合结果，按 score 倒序） */
  search: (q: string) =>
    api.get<{ results: KnowledgeSearchResult[] }>('/knowledge/search', { params: { q } }),

  /** 冷启动导入：扫描目录，返回可导入文件列表（KnowledgeImportPage） */
  importScan: (data: { projectId: string; scanPath?: string; maxDepth?: number }) =>
    api.post<ImportScanResult>('/knowledge/import/scan', data),

  /** 冷启动导入：导入选中文件为知识条目（KnowledgeImportPage） */
  importExecute: (data: {
    projectId: string;
    files: Array<{ path: string; type?: string; title?: string; tags?: string[] }>;
  }) => api.post<ImportExecuteResult>('/knowledge/import/execute', data),
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

/** 冷启动导入扫描到的文件（POST /knowledge/import/scan 的 files 元素） */
export interface ImportScannedFile {
  path: string;
  name: string;
  relativePath: string;
  size: number;
  ext: string;
  inferredType: string;
  tags: string[];
  modifiedAt: string;
}

/** POST /knowledge/import/scan 响应体（后端直接 res.json，无 success 信封） */
export interface ImportScanResult {
  projectId: string;
  projectTitle: string;
  scanPath: string;
  totalFiles: number;
  byType: Record<string, number>;
  files: ImportScannedFile[];
}

/** POST /knowledge/import/execute 响应体 */
export interface ImportExecuteResult {
  imported: number;
  skipped: number;
  errors: number;
  results: Array<{ path: string; status: string; documentId?: string; error?: string }>;
}
