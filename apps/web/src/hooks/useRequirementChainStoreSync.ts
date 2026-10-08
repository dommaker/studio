// useRequirementChainStoreSync — requirementChainStore 的实时接线（#412，机制照 useRosterStoreSync）
// SSE workunit.status_changed → store.applyWorkunitStatusChanged（更新逻辑唯一一份在 store）；
// 重连强刷 / useGatedPoll 兜底 / 引用计数单例全在 useDataPlaneSync（ensureFresh = 已缓存 chain 全量对齐）。
// 挂载点：App 级单点（App.tsx SseProvider 内）——chain 消费方分布在频道页/项目页/抽屉/弹窗，
// 事件路由不随组件挂卸增减；无缓存 chain 时事件处理是 map 查找 miss，零请求零开销。
import { type SseMessage } from '../api/sseHooks';
import {
  useRequirementChainStore,
  REQUIREMENT_CHAIN_POLL_INTERVAL_MS,
} from '../stores/requirementChainStore';
// #665：workunit.status_changed 负载 = studio-contract 同源（{ workunit: WorkUnit } 信封）
import type { WorkunitEventPayload } from '@dommaker/studio-contract';
import { useDataPlaneSync } from './useDataPlaneSync';

function handleChainEvent(msg: SseMessage) {
  if (msg.event_type !== 'workunit.status_changed') return;
  const wu = (msg.data as WorkunitEventPayload | null)?.workunit;
  if (wu?.id) useRequirementChainStore.getState().applyWorkunitStatusChanged(wu);
}

/** 引用稳定（useDataPlaneSync 的 effect 依赖要求）：chain 数据面的统一取数入口 */
function chainEnsureFresh(opts?: { maxAgeMs?: number }): Promise<void> {
  return useRequirementChainStore.getState().ensureFresh(opts);
}

export function useRequirementChainStoreSync(): void {
  useDataPlaneSync({
    handleEvent: handleChainEvent,
    ensureFresh: chainEnsureFresh,
    pollIntervalMs: REQUIREMENT_CHAIN_POLL_INTERVAL_MS,
  });
}
