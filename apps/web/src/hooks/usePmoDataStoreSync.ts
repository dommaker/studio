// usePmoDataStoreSync — pmoDataStore 的实时接线（#456，机制照 useRequirementChainStoreSync）
// 无 SSE 失效事件可用（ADR 2026-08-31 决策 3：不为词表/PMO/成员新增事件）→ handleEvent 为 noop；
// 新鲜度 = TTL + 重连强刷（ensureFresh({maxAgeMs:0})：companies + 已驻留 projects 键全量对齐）+
// useGatedPoll 兜底，机制全在 useDataPlaneSync（禁止逐 store 复印）。
// 挂载点：App 级单点（App.tsx PmoDataSync，WebSocketProvider 内）——消费方分布在
// PMOPage / LibraryPage / FileRefChip，接线不随页面挂卸增减（同 RequirementChainSync 模式）。
import { type WebSocketMessage } from '../api/websocketHooks';
import { usePmoDataStore, PMO_DATA_POLL_INTERVAL_MS } from '../stores/pmoDataStore';
import { useDataPlaneSync } from './useDataPlaneSync';

// 无本域 SSE 事件可接（决策 3）——占位 noop 保持 useDataPlaneSync 统一接线形态
function handlePmoDataEvent(_msg: WebSocketMessage): void {}

/** 引用稳定（useDataPlaneSync 的 effect 依赖要求）：PMO 数据面的统一取数入口 */
function pmoDataEnsureFresh(opts?: { maxAgeMs?: number }): Promise<void> {
  return usePmoDataStore.getState().ensureFresh(opts);
}

export function usePmoDataStoreSync(): void {
  useDataPlaneSync({
    handleEvent: handlePmoDataEvent,
    ensureFresh: pmoDataEnsureFresh,
    pollIntervalMs: PMO_DATA_POLL_INTERVAL_MS,
  });
}
