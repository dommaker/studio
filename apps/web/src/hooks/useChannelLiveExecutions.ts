// 频道 live 执行状态条数据源（#242）：本频道执行中 WU 集合 + 最新步号
// B3（2026-09 频道前端效率批）：active 集合改为从 channelWorkStore.wus[channelId] 派生
// （filter status==='active'），不再独立拉 GET /workunits?status=active 打底、不再自备
// status_changed 簿记——WU 事实源单一（REST 打底 + status_changed 全量快照直替都在 store/sync 层），
// 消除两路拉取与双口径漂移。注意 store 语义：未打底频道 applyWorkunitSnapshot no-op，
// 故 live 集以 wus slice 成功落库为前提（TTL 内零重拉，失败由下次 ensure/兜底轮询自愈）。
// 本 hook 只保留 step 事件簿记（步号不在 WU 快照契约内）：
//   - workunit.execution.step：更新步号/动作（SSE 负载深化 决策 4：负载带 channelId 时按频道过滤，
//     缺省（旧后端）保持现状不过滤）
//   - workunit.status_changed：仅作终态 step 条目清理（防内存残留，不限频道）
// 展示模型推导 = execution-rows.deriveLiveExecutions（#240 推导层复用）。
import { useEffect, useMemo, useState } from 'react';
import { useWebSocketContext } from '../api/websocketHooks';
import { useChannelWorkStore } from '../stores/channelWorkStore';
import {
  deriveLiveExecutions,
  parseLiveStepRef,
  parseLiveWuRef,
  type LiveExecution,
} from '../components/workunit/execution-rows';

export function useChannelLiveExecutions(channelId: string | null): LiveExecution[] {
  const { onEvent } = useWebSocketContext();
  const wus = useChannelWorkStore(s => (channelId ? s.wus[channelId] : undefined));
  const [steps, setSteps] = useState<Record<string, { step: number; action?: string }>>({});

  // 渲染期按 channelId 重置步索引（同 ExecutionSteps 惯例：替代 effect 内同步重置，避免闪烁）
  const [prevChannelId, setPrevChannelId] = useState(channelId);
  if (prevChannelId !== channelId) {
    setPrevChannelId(channelId);
    setSteps({});
  }

  // 打底触发（TTL/single-flight 在 store 内；页面 sync 层已打底时零成本并入）
  useEffect(() => {
    if (!channelId) return;
    void useChannelWorkStore.getState().ensureWus(channelId);
  }, [channelId]);

  useEffect(() => {
    if (!channelId) return;
    return onEvent(msg => {
      if (msg.event_type === 'workunit.execution.step') {
        const ref = parseLiveStepRef(msg.data);
        if (!ref) return;
        // 决策 4：负载带 channelId → 他频道步事件直接丢弃（不再产生他频道条目）；
        // channelId 缺省（旧后端）不过滤，向后兼容
        if (ref.channelId && ref.channelId !== channelId) return;
        setSteps(prev => {
          const cur = prev[ref.workUnitId];
          // F3 等值守卫：同 wuId 内容等值（step 与 action 均同）→ 跳过 setState，不切重渲
          if (cur && cur.step === ref.step && cur.action === ref.action) return prev;
          return { ...prev, [ref.workUnitId]: { step: ref.step, ...(ref.action ? { action: ref.action } : {}) } };
        });
        return;
      }
      if (msg.event_type === 'workunit.status_changed') {
        const wu = parseLiveWuRef(msg.data);
        if (!wu || wu.status === 'active') return;
        // 终态清理步条目不限频道：step 事件缺 channelId 时他频道条目仍会进入 steps，
        // 其 status_changed 若被频道过滤挡住将永不清理（内存残留修复）。
        // live 集合本身的增删不由本 hook 管——channelWorkStore 快照直替派生
        setSteps(prev => {
          if (!(wu.id in prev)) return prev;
          const next = { ...prev };
          delete next[wu.id];
          return next;
        });
      }
    });
  }, [channelId, onEvent]);

  const activeWus = useMemo(
    () => (wus ?? []).filter(w => w.status === 'active').map(w => ({ id: w.id, metadata: w.metadata })),
    [wus],
  );
  return deriveLiveExecutions(activeWus, steps);
}
