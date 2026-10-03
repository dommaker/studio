// Requirement API — REQ 需求编号体系（vision §5.3）
// 契约驱动迁移（2026-09 批次 1/7）：类型 import 自 @dommaker/studio-contract，
// 响应壳统一 { data }（原 {success,data} 手抄声明删除）。
import type {
  Requirement,
  RequirementStatus,
  RequirementChainWorkUnit,
  RequirementChain,
  ChainStatsResult,
} from '@dommaker/studio-contract';
import { api } from './index';

export type { Requirement, RequirementStatus, RequirementChainWorkUnit, RequirementChain };

export const requirementApi = {
  list: (params?: { status?: string; channelId?: string }) =>
    api.get<{ data: Requirement[] }>('/requirements', { params }),

  get: (id: string) =>
    api.get<{ data: Requirement }>(`/requirements/${id}`),

  create: (data: { title: string; channelId?: string; description?: string }) =>
    api.post<{ data: Requirement }>('/requirements', data),

  update: (id: string, data: { title?: string; status?: RequirementStatus; docs?: string[]; description?: string }) =>
    api.patch<{ data: Requirement }>(`/requirements/${id}`, data),

  getChain: (id: string) =>
    api.get<{ data: RequirementChain }>(`/requirements/${id}/chain`),

  /** #387 批量徽章统计：每需求 {finished,total}（PMO 卡片用，替代逐项目 getChain 的 N+1；不存在的需求无 key） */
  chainStats: (reqIds: string[]) =>
    api.get<{ data: ChainStatsResult }>(
      '/requirements/chain-stats',
      { params: { reqIds: reqIds.join(',') } },
    ),
};
