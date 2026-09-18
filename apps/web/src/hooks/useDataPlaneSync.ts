// useDataPlaneSync — 数据面 store 的 SSE/轮询接线底座（#403，ADR 2026-08-31 决策 6）
// 从 useRosterStoreSync 抽出的通用接线：① SSE 事件路由进 store（引用计数单例：首个挂载注册、
// 最后一个卸载退订，多消费方挂载不放大订阅——handleEvent 必须引用稳定，模块级函数）；
// ② SSE 重连一次性强制对齐（SSE 负载契约 ADR D3：断线期间 missed events 不回放，重连时 REST
// refetch 打底；多消费方同时触发由 single-flight 收敛为一次）；③ useGatedPoll 兜底（SSE 断开且
// 页面 visible 才轮询，TTL 门禁保证多消费方错峰计时器不放大请求数）。
// 事件处理逻辑唯一一份在 store action；本 hook 只做接线。
import { useEffect, useRef } from 'react';
import { useWebSocketContext, type WebSocketMessage } from '../api/websocketHooks';
import { useGatedPoll } from './useGatedPoll';

export interface DataPlaneSyncOptions {
  /** SSE 事件处理器（引用稳定——引用计数单例按首挂载注册的实例退订） */
  handleEvent: (msg: WebSocketMessage) => void;
  /** 重连强刷与兜底轮询的目标（ensureFresh 自带 TTL 门禁；引用稳定） */
  ensureFresh: (opts?: { maxAgeMs?: number }) => Promise<void>;
  /** 兜底轮询周期；<= 0 = 停用轮询兜底（#549：只接 SSE + 重连的 store 维持无轮询现状） */
  pollIntervalMs: number;
}

let syncRefCount = 0;
let detachEvent: (() => void) | null = null;

export function useDataPlaneSync({ handleEvent, ensureFresh, pollIntervalMs }: DataPlaneSyncOptions): void {
  const { onEvent, onReconnect } = useWebSocketContext();
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  // 引用计数单例：重复挂载不放大订阅（provider 的 onEvent 引用稳定）
  useEffect(() => {
    syncRefCount += 1;
    if (syncRefCount === 1) {
      detachEvent = onEventRef.current(handleEvent);
    }
    return () => {
      syncRefCount -= 1;
      if (syncRefCount === 0 && detachEvent) {
        detachEvent();
        detachEvent = null;
      }
    };
    // handleEvent / onEvent 引用稳定（模块级），挂载期不重注册
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SSE 重连 → 强制对齐（多消费方同时触发由 single-flight 收敛为一次）
  useEffect(() => onReconnect?.(() => { void ensureFresh({ maxAgeMs: 0 }); }), [onReconnect, ensureFresh]);

  // 兜底轮询：ensureFresh 自带 TTL 门禁，多消费方错峰计时器不会放大请求数
  useGatedPoll(() => { void ensureFresh(); }, pollIntervalMs);
}
