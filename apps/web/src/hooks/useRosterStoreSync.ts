// useRosterStoreSync — rosterStore 的实时接线（#346；#403 起接线机制抽至 useDataPlaneSync 底座）
// 职责三件：① SSE agent.instance.status_changed / workunit.status_changed → store action（更新逻辑唯一一份在 store）；
// ② useGatedPoll(ensureFresh) 兜底（#313：SSE 断开且页面 visible 才轮询，TTL 门禁保证多消费方挂载也至多
//    一个 TTL 窗口一次真实拉取）；③ SSE 重连一次性强制对齐（SSE 负载契约 ADR D3：断线期间 missed events 不回放，
//    重连时 REST refetch 打底）。
// 引用计数单例、重连强刷、门禁轮询全在 useDataPlaneSync；本文件只剩 roster 的事件路由与参数。
import { type WebSocketMessage } from '../api/websocketHooks';
import { useRosterStore, ROSTER_POLL_INTERVAL_MS, type AgentStatusChangedData } from '../stores/rosterStore';
import { useDataPlaneSync } from './useDataPlaneSync';

function handleRosterEvent(msg: WebSocketMessage) {
  const store = useRosterStore.getState();
  if (msg.event_type === 'agent.instance.status_changed') {
    store.applyInstanceStatusEvent((msg.data ?? {}) as AgentStatusChangedData);
    return;
  }
  if (msg.event_type === 'workunit.status_changed') {
    const wu = (msg.data as { workunit?: { id: string } } | null)?.workunit;
    if (wu?.id) store.applyWorkunitStatusEvent(wu);
  }
}

/** 引用稳定（useDataPlaneSync 的 effect 依赖要求）：roster 数据面的统一取数入口 */
function rosterEnsureFresh(opts?: { maxAgeMs?: number }): Promise<void> {
  return useRosterStore.getState().ensureFresh(opts);
}

export function useRosterStoreSync(): void {
  useDataPlaneSync({ handleEvent: handleRosterEvent, ensureFresh: rosterEnsureFresh, pollIntervalMs: ROSTER_POLL_INTERVAL_MS });
}
