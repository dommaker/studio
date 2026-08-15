// Maintenance API — 手动任务按钮（触发器手动 fire / 成本聚合 / 知识库维护）
// #149（2026-08-15）：runMesoEvolution 随知识进化引擎（document-store 退役）一并摘除
import { api } from './index';

/** POST /triggers/:id/fire 响应（CREATE 型带 workUnit；EXECUTE 型没有） */
export interface FireTriggerResult {
  fired: boolean;
  wasDisabled: boolean;
  workUnit?: { id: string; scope: string };
}

/** GET /triggers/costs 响应（byTrigger/bySource 为 token 数；callsBySource 为调用次数——
 *  system:tokens 的 usage 常缺失（CLI 不回传），此时只能用调用次数近似成本） */
export interface TriggerCosts {
  days: number;
  byTrigger: Record<string, number>;
  bySource: Record<string, number>;
  callsBySource: Record<string, number>;
}

/** POST /knowledge/maintenance/run 响应（F1：去重/质量/过期/矛盾） */
export interface KnowledgeMaintenanceResult {
  dedupMerged: number;
  qualityArchived: number;
  freshnessUpdated: number;
  contradictionsResolved: number;
}

export const maintenanceApi = {
  /** 手动触发一个触发器 */
  fireTrigger: async (id: string): Promise<FireTriggerResult> => {
    const res = await api.post<FireTriggerResult>(`/triggers/${id}/fire`);
    return res.data;
  },

  /** 触发器成本聚合（token 数；默认近 30 天） */
  getCosts: async (days = 30): Promise<TriggerCosts> => {
    const res = await api.get<TriggerCosts>('/triggers/costs', { params: { days } });
    return res.data;
  },

  /** 手动跑知识库维护（可能耗时几分钟，timeout 10 分钟） */
  runKnowledgeMaintenance: async (): Promise<KnowledgeMaintenanceResult> => {
    const res = await api.post<KnowledgeMaintenanceResult>('/knowledge/maintenance/run', undefined, {
      timeout: 600_000,
    });
    return res.data;
  },
};
