// Company API — 公司 CRUD（FileStore 存储；Settings 页 / PMOPage 共用）
// 契约驱动迁移（2026-10 批次 2/7）：Company 类型 import 自 @dommaker/studio-contract
// （原手抄 interface 删除；createdAt/updatedAt 可缺省是漂移——后端恒返回，契约按必填）；
// 响应统一 { data } 壳（get/create/update 原裸 Company 对象）。
import type { Company } from '@dommaker/studio-contract';
import { api } from './index';

export type { Company };

export const companyApi = {
  /** 公司列表（服务端按 createdAt 倒序；消费方取 [0] 作为默认公司） */
  list: () => api.get<{ data: Company[] }>('/companies'),

  get: (companyId: string) => api.get<{ data: Company }>(`/companies/${companyId}`),

  /** 创建公司（服务端自动建默认 OKR；201 返回 `{ data: Company }`） */
  create: (data: { name: string }) => api.post<{ data: Company }>('/companies', data),

  update: (companyId: string, data: { name: string }) =>
    api.patch<{ data: Company }>(`/companies/${companyId}`, data),
};
