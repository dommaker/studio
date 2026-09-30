// PMO OKR API — /pmo/okr（PMOPage OKR 列表/新建、PMOCard 统计）
// 注：PMO 项目 CRUD 在 api/index.ts 的 projectApi（历史位置，未迁移）
// 契约驱动迁移（2026-10 批次 2/7）：Okr/OkrKeyResult 类型 import 自 @dommaker/studio-contract
// （原手抄 interface 删除；objectives/keyResults 可缺省是漂移——后端恒返回，契约按必填）；
// create 响应统一 { data } 壳（原 201 裸 OKR 对象）。
import type { Okr, OkrKeyResult, OkrMutationResult } from '@dommaker/studio-contract';
import { api } from './index';

export type { Okr, OkrKeyResult };

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
