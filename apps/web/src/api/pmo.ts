// PMO OKR API — /pmo/okr（PMOPage OKR 列表/新建、PMOCard 统计）
// 注：PMO 项目 CRUD 在 api/index.ts 的 projectApi（历史位置，未迁移）
import { api } from './index';

export interface OkrKeyResult {
  id: string;
  objectiveId?: string;
  title: string;
  target: number;
  current?: number;
  unit?: string;
  metricType?: string;
}

/** OKR 条目（GET /pmo/okr 的 data 元素；只声明 UI 消费字段） */
export interface Okr {
  id: string;
  title: string;
  quarter: string;
  status: string;
  progress: number;
  projectCount: number;
  objectives?: Array<{ id: string; title: string; description?: string }>;
  keyResults?: OkrKeyResult[];
}

export const okrApi = {
  /** OKR 列表（companyId 必填，缺省服务端 400） */
  list: (companyId: string, status?: string) =>
    api.get<{ data: Okr[] }>('/pmo/okr', { params: { companyId, status } }),

  /** 创建 OKR（requireAuth + requireNotGuest；201 返回裸 OKR 对象） */
  create: (data: {
    companyId: string;
    title: string;
    quarter: string;
    objectives?: Array<{ id: string; title: string }>;
    keyResults?: OkrKeyResult[];
  }) => api.post<Okr>('/pmo/okr', data),
};
