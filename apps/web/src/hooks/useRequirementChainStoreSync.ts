// useRequirementChainStoreSync — requirementChainStore 的实时接线（#412，机制照 useRosterStoreSync）
// SSE workunit.status_changed → store.applyWorkunitStatusChanged（更新逻辑唯一一份在 store）；
// 重连强刷 / useGatedPoll 兜底 / 引用计数单例全在 useDataPlaneSync（ensureFresh = 已缓存 chain 全量对齐）。
// 挂载点：App 级单点（App.tsx WebSocketProvider 内）——chain 消费方分布在频道页/项目页/抽屉/弹窗，
// 事件路由不随组件挂卸增减；无缓存 chain 时事件处理是 map 查找 miss，零请求零开销。
import { type WebSocketMessage } from '../api/websocketHooks';
import {
  useRequirementChainStore,
  REQUIREMENT_CHAIN_POLL_INTERVAL_MS,
  type WorkunitStatusPayload,
} from '../stores/requirementChainStore';
import { useDataPlaneSync } from './useDataPlaneSync';

function handleChainEvent(msg: WebSocketMessage) {
  if (msg.event_type !== 'workunit.status_changed') return;
  const wu = (msg.data as { workunit?: WorkunitStatusPayload | null } | null)?.workunit;
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
