// 频道 live 执行状态条数据源（#242）：本频道执行中 WU 集合 + 最新步号
// 事件全部复用现有 SSE（不新增事件类型）：
//   - 初始/兜底：workunitApi.list({channelId, status:'active'})（进频道时已在执行的不漏）
//   - workunit.status_changed：active → 加入集合；其余状态 → 移出（终态状态条消失）
//   - workunit.execution.step：更新步号/动作（SSE 负载深化 决策 4：负载带 channelId 时按频道过滤，
//     缺省（旧后端）保持现状不过滤）
// 展示模型推导 = execution-rows.deriveLiveExecutions（#240 推导层复用），本 hook 只做订阅与集合维护。
import { useEffect, useState } from 'react';
import { useWebSocketContext } from '../api/websocketHooks';
import { workunitApi } from '../api/workunit';
import {
  deriveLiveExecutions,
  parseLiveStepRef,
  parseLiveWuRef,
  type LiveExecution,
} from '../components/workunit/execution-rows';

interface ActiveWu {
  id: string;
  metadata: string | null;
}

export function useChannelLiveExecutions(channelId: string | null): LiveExecution[] {
  const { onEvent } = useWebSocketContext();
  const [activeWus, setActiveWus] = useState<ActiveWu[]>([]);
  const [steps, setSteps] = useState<Record<string, { step: number; action?: string }>>({});

  // 渲染期按 channelId 重置（同 ExecutionSteps 惯例：替代 effect 内同步重置，避免闪烁）
  const [prevChannelId, setPrevChannelId] = useState(channelId);
  if (prevChannelId !== channelId) {
    setPrevChannelId(channelId);
    setActiveWus([]);
    setSteps({});
  }

  useEffect(() => {
    if (!channelId) return;
    let alive = true;
    workunitApi.list({ channelId, status: 'active', limit: 100 })
      .then(r => { if (alive) setActiveWus(r.data.data.map(w => ({ id: w.id, metadata: w.metadata }))); })
      .catch(() => {});
    return () => { alive = false; };
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
        setSteps(prev => ({ ...prev, [ref.workUnitId]: { step: ref.step, ...(ref.action ? { action: ref.action } : {}) } }));
        return;
      }
      if (msg.event_type === 'workunit.status_changed') {
        const wu = parseLiveWuRef(msg.data);
        if (!wu) return;
        // 终态清理步条目不限频道：step 事件缺 channelId 时他频道条目仍会进入 steps，
        // 其 status_changed 若被下方频道早退挡住将永不清理（内存残留修复）
        if (wu.status !== 'active') {
          setSteps(prev => {
            if (!(wu.id in prev)) return prev;
            const next = { ...prev };
            delete next[wu.id];
            return next;
          });
        }
        if (wu.channelId !== channelId) return;
        if (wu.status === 'active') {
          setActiveWus(prev => {
            const next: ActiveWu = { id: wu.id, metadata: wu.metadata };
            return prev.some(w => w.id === wu.id)
              ? prev.map(w => (w.id === wu.id ? next : w))
              : [...prev, next];
          });
        } else {
          setActiveWus(prev => prev.filter(w => w.id !== wu.id));
        }
      }
    });
  }, [channelId, onEvent]);

  return deriveLiveExecutions(activeWus, steps);
}
