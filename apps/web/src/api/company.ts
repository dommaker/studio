// Company API — 公司 CRUD（FileStore 存储；Settings 页 / useCompanyId / PMOPage 共用）
// 响应形状：list = { data: Company[] }；get/create/update = 裸 Company 对象（后端直接 res.json(company)）
import { api } from './index';

export interface Company {
  id: string;
  name: string;
  size: string;
  createdAt?: string;
  updatedAt?: string;
}

export const companyApi = {
  /** 公司列表（服务端按 createdAt 倒序；消费方取 [0] 作为默认公司） */
  list: () => api.get<{ data: Company[] }>('/companies'),

  get: (companyId: string) => api.get<Company>(`/companies/${companyId}`),

  /** 创建公司（服务端自动建默认 OKR；201 返回裸 Company） */
  create: (data: { name: string }) => api.post<Company>('/companies', data),

  update: (companyId: string, data: { name: string }) =>
    api.patch<Company>(`/companies/${companyId}`, data),
};
