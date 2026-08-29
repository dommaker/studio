// useRosterStoreSync — rosterStore 的实时接线（#346）
// 职责三件：① SSE agent.instance.status_changed / workunit.status_changed → store action（更新逻辑唯一一份在 store）；
// ② useGatedPoll(ensureFresh) 兜底（#313：SSE 断开且页面 visible 才轮询，TTL 门禁保证多消费方挂载也至多
//    一个 TTL 窗口一次真实拉取）；③ SSE 重连一次性强制对齐（SSE 负载契约 ADR D3：断线期间 missed events 不回放，
//    重连时 REST refetch 打底）。
// 引用计数单例：ChannelRail / useAgentRoster 等都可能挂载，首个挂载注册监听、
// 最后一个卸载退订；重复挂载不放大订阅与请求（provider 的 onEvent 引用稳定）。
import { useEffect, useRef } from 'react';
import { useWebSocketContext, type WebSocketMessage } from '../api/websocketHooks';
import { useRosterStore, ROSTER_POLL_INTERVAL_MS, type AgentStatusChangedData } from '../stores/rosterStore';
import { useGatedPoll } from './useGatedPoll';

let syncRefCount = 0;
let detachEvent: (() => void) | null = null;

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

export function useRosterStoreSync(): void {
  const { onEvent, onReconnect } = useWebSocketContext();
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    syncRefCount += 1;
    if (syncRefCount === 1) {
      detachEvent = onEventRef.current(handleRosterEvent);
    }
    return () => {
      syncRefCount -= 1;
      if (syncRefCount === 0 && detachEvent) {
        detachEvent();
        detachEvent = null;
      }
    };
  }, []);

  // SSE 重连 → 强制对齐（多消费方同时触发由 single-flight 收敛为一次）
  useEffect(() => onReconnect?.(() => { void useRosterStore.getState().ensureFresh({ maxAgeMs: 0 }); }), [onReconnect]);

  // 兜底轮询：ensureFresh 自带 TTL 门禁，多消费方错峰计时器不会放大请求数
  useGatedPoll(() => { void useRosterStore.getState().ensureFresh(); }, ROSTER_POLL_INTERVAL_MS);
}
