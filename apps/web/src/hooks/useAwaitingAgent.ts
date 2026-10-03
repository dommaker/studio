// useAwaitingAgent — #493 线程回复送达后的轻量「已送达/等待 agent」状态（P3-b 自 ChannelDetailPage 切出）：
// 线程回复送达且命中 WU（workUnitId 继承成功 = 会触达 agent）→ notifyReplySent 置位；
// agent 已响应（该 WU 的 agent 新消息到达）→ render 派生 answered 隐藏（不做 effect 内同步 setState，
// 判定本体 = channelMessageStore 旁挂纯函数 agentAnsweredOf，#548 迁出口径）；
// 30s 兜底定时器清 state 本体（agent 无响应时条不常住；30s 口径 > 唤醒+认领秒级路径，
// loop 异常时由工作条/建议片承接下来）。
import { useCallback, useEffect, useState } from 'react';
import { agentAnsweredOf } from '../stores/channelMessageStore';
import type { ChannelMessage } from '../api/channel';

export interface AwaitingAgentState {
  wuId: string;
  since: number;
}

export function useAwaitingAgent(messages: ChannelMessage[]) {
  const [awaiting, setAwaiting] = useState<AwaitingAgentState | null>(null);

  // render 派生：agent 新消息到达即已应答（与 useStreamFollow ownSendPending 窗口同一局限——
  // 消息模型只有 authorType 无 authorId，区分不到个人）
  const answered = agentAnsweredOf(messages, awaiting);

  useEffect(() => {
    if (!awaiting) return;
    const timer = setTimeout(() => setAwaiting(null), 30_000);
    return () => clearTimeout(timer);
  }, [awaiting]);

  /** 线程回复送达且命中 WU 时调用（发送链路唯一写口） */
  const notifyReplySent = useCallback((wuId: string) => {
    setAwaiting({ wuId, since: Date.now() });
  }, []);

  return { awaiting, answered, notifyReplySent };
}
