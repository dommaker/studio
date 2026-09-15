// useGatedPoll — 共享门禁轮询（#313，架构评审候选 8）：替代各组件复制的 setInterval 样板。
// 语义：挂载首拉一次；仅当（页面 visible ∧ SSE status ≠ 'connected'）按 intervalMs 轮询；
// 页面回 visible 立即补拉一次并恢复计时。消费方各自的 403 终态/错误处理留在 fetch 闭包内。
// 对齐频道消息既有模式（useChannelEvents：SSE 断开才 10s 轮询兜底），并补 visibility 门禁。
// intervalMs <= 0 = 完全停用（#549：只接 SSE + 重连对齐的 store 不加轮询兜底，
// 挂载首拉/回 visible 补拉一并跳过——取数时机全由 SSE 路由与重连强刷承担）。
import { useEffect, useRef, useState } from 'react';
import { useWebSocketContext } from '../api/websocketHooks';

export function useGatedPoll(fetch: () => void | Promise<void>, intervalMs: number) {
  const { status } = useWebSocketContext();
  const fetchRef = useRef(fetch);
  useEffect(() => {
    fetchRef.current = fetch;
  });

  const enabled = intervalMs > 0;
  const [visible, setVisible] = useState(() => !document.hidden);

  // 挂载首拉（微任务：对齐各消费方既有首拉纪律——编译器对 effect 内同步调用多语句 async 保守告警）
  useEffect(() => {
    if (!enabled) return;
    void Promise.resolve().then(() => fetchRef.current());
  }, [enabled]);

  // visibility 门禁：回 visible 立即补拉一次（无论 SSE 状态——切回标签页应看到新鲜数据）
  useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      const v = !document.hidden;
      setVisible(v);
      if (v) void fetchRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled]);

  // 轮询门禁：SSE 断开才兜底，页面隐藏停表
  useEffect(() => {
    if (!enabled || status === 'connected' || !visible) return;
    const timer = setInterval(() => void fetchRef.current(), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, status, visible, intervalMs]);
}
