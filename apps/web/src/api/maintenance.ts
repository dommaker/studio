// Maintenance API — 手动任务按钮（触发器手动 fire / 成本聚合 / 知识库维护）
// #149（2026-08-15）：runMesoEvolution 随知识进化引擎（document-store 退役）一并摘除
// 契约驱动迁移（2026-10 批次 3/7）：FireTriggerResult/TriggerCosts 手抄删除改 contract
// import；fire/costs 响应统一 { data } 壳（原平铺），消费方解包 res.data → res.data.data。
// 批次 4/7：KnowledgeMaintenanceResult 手抄删除改 contract import；runKnowledgeMaintenance
// 响应统一 { data } 壳（原平铺），解包 res.data → res.data.data。
import type { FireTriggerResult, TriggerCostsResult, KnowledgeMaintenanceResult } from '@dommaker/studio-contract';
import { api } from './index';

/** GET /triggers/costs 响应 data（byTrigger/bySource 为 token 数；callsBySource 为调用次数——
 *  system:tokens 的 usage 常缺失（CLI 不回传），此时只能用调用次数近似成本） */
export type TriggerCosts = TriggerCostsResult;
export type { FireTriggerResult, KnowledgeMaintenanceResult };

export const maintenanceApi = {
  /** 手动触发一个触发器 */
  fireTrigger: async (id: string): Promise<FireTriggerResult> => {
    const res = await api.post<{ data: FireTriggerResult }>(`/triggers/${id}/fire`);
    return res.data.data;
  },

  /** 触发器成本聚合（token 数；默认近 30 天） */
  getCosts: async (days = 30): Promise<TriggerCosts> => {
    const res = await api.get<{ data: TriggerCosts }>('/triggers/costs', { params: { days } });
    return res.data.data;
  },

  /** 手动跑知识库维护（可能耗时几分钟，timeout 10 分钟） */
  runKnowledgeMaintenance: async (): Promise<KnowledgeMaintenanceResult> => {
    const res = await api.post<{ data: KnowledgeMaintenanceResult }>('/knowledge/maintenance/run', undefined, {
      timeout: 600_000,
    });
    return res.data.data;
  },
};
