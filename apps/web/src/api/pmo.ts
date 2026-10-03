// PMO API — /pmo/project（projectApi，P3-a 自 api/index.ts 归位）+ /pmo/okr（okrApi：
// PMOPage OKR 列表/新建、PMOCard 统计）
// 契约驱动迁移（2026-10 批次 2/7）：类型 import 自 @dommaker/studio-contract
// （原手抄 interface 删除；Okr objectives/keyResults 可缺省是漂移——后端恒返回，契约按必填）；
// 响应统一 { data } 壳（单体/交付/发布原裸对象，create 原 201 裸 OKR 对象）。
import type {
  Okr,
  OkrKeyResult,
  OkrMutationResult,
  Project,
  DeliveryStatus,
  DeliveryGap,
  DeliverResult,
  MarkDeliveredResult,
  ParsePmoCommandResult,
  PublishProjectResult,
  DeliveryPolicy,
} from '@dommaker/studio-contract';
import { api } from './index';

// 🆕 PMO-b: 交付台账类型（GET /pmo/project/:id/delivery 响应形状）——
// 契约驱动迁移（2026-10 批次 2/7）：import 自 contract，原手抄 interface 删除
// （手抄版缺 channelId 是漂移——后端恒返回）。
export type { Okr, OkrKeyResult, DeliveryStatus, DeliveryGap, Project };

// Project API - GEN-005: PMO 项目管理
// 契约驱动迁移（2026-10 批次 2/7）：响应统一 { data } 壳（单体/交付/发布原裸对象），
// 类型 import 自 @dommaker/studio-contract。
export const projectApi = {
  // 创建项目（自动生成 PMO 号；PMO-a: companyId 由服务端解析，前端不再传）
  // #114 T8：gitRepos 多工程入参（每选中工程一条交付腿）；单个工程仍走 gitRepo
  create: (data: {
    title: string;
    description?: string;
    requirement?: string;
    okrId?: string;
    priority?: string;
    gitBranch?: string;
    gitRepo?: string;
    gitRepos?: string[];
    deliveryPolicy?: DeliveryPolicy;
    requirementsDocId?: string;
  }) => api.post<{ data: Project }>('/pmo/project', data),

  // 获取项目列表
  list: (params?: {
    companyId: string;
    status?: string;
    priority?: string;
    okrId?: string;
    limit?: number;
  }) => api.get<{ data: Project[] }>('/pmo/project', { params }),

  // 获取项目详情
  get: (id: string) => api.get<{ data: Project }>(`/pmo/project/${id}`),

  // 通过 PMO 号获取项目
  getByPmoNumber: (pmoNumber: string, companyId: string) =>
    api.get<{ data: Project }>(`/pmo/project/by-pmo/${pmoNumber}`, { params: { companyId } }),

  // 更新项目
  update: (id: string, data: {
    title?: string;
    description?: string;
    okrId?: string;
    status?: string;
    priority?: string;
    progress?: number;
  }) => api.put<{ data: Project }>(`/pmo/project/${id}`, data),

  // 更新项目状态
  updateStatus: (id: string, status: string) =>
    api.put<{ data: Project }>(`/pmo/project/${id}/status`, { status }),

  // 发布 PMO 到 Channel（#177：可选 assigneeId 指派 analysis WU 执行角色，留空=涌现）
  publish: (id: string, channelId: string, assigneeId?: string) =>
    api.post<{ data: PublishProjectResult }>(`/pmo/project/${id}/publish`, { channelId, ...(assigneeId ? { assigneeId } : {}) }),

  // 删除项目
  delete: (id: string) => api.delete<{ data: { success: boolean } }>(`/pmo/project/${id}`),

  // 解析 CEO 指令中的 PMO 号
  parseCommand: (command: string) =>
    api.post<{ data: ParsePmoCommandResult }>('/pmo/project/parse-command', { command }),

  // 🆕 PMO-b: 交付台账
  getDelivery: (id: string) => api.get<{ data: DeliveryStatus }>(`/pmo/project/${id}/delivery`),

  // 🆕 PMO-b: 交付合并（human-only；branch-only 返回 409 BRANCH_ONLY）
  deliver: (id: string) => api.post<{ data: DeliverResult }>(`/pmo/project/${id}/deliver`),

  // #469: branch-only 标记已交付（系统外合并后人工落档 commit 哈希，写 deliveredAt/By/Commit）
  markDelivered: (id: string, commit: string) =>
    api.post<{ data: MarkDeliveredResult }>(`/pmo/project/${id}/mark-delivered`, { commit }),

};

export const okrApi = {
  /** OKR 列表（companyId 必填，缺省服务端 400） */
  list: (companyId: string, status?: string) =>
    api.get<{ data: Okr[] }>('/pmo/okr', { params: { companyId, status } }),

  /** 创建 OKR（requireAuth + requireNotGuest；201 返回 `{ data: OkrMutationResult }`） */
  create: (data: {
    companyId: string;
    title: string;
    quarter: string;
    objectives?: Array<{ id: string; title: string }>;
    keyResults?: OkrKeyResult[];
  }) => api.post<{ data: OkrMutationResult }>('/pmo/okr', data),
};
