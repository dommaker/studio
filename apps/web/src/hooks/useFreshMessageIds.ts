// useFreshMessageIds — #548 自 ChannelDetailPage 迁出（逻辑逐行不变）：
// 批次 E-3 SSE 新到达消息渐隐高亮的 id 集（白名单③状态色切换：accent-dim 底色 → 常态）。
// 口径 = 全部新到达消息（含自己发送的回显——消息模型只有 authorType 无 authorId，区分不到个人，
// 与 useStreamFollow ownSendPending 窗口同一局限）；首拉与翻页 prepend/水合归并的历史不标
// （createdAt 早于到达前最新一条即历史）。2s 后移类，经 .mc-msg 基类过渡渐隐。
import { useEffect, useRef, useState } from 'react';
import type { ChannelMessage } from '../api/channel';

export function useFreshMessageIds(messages: ChannelMessage[]): ReadonlySet<string> {
  const [freshMsgIds, setFreshMsgIds] = useState<ReadonlySet<string>>(new Set());
  const msgTrackRef = useRef<{ ids: Set<string>; latestTs: number } | null>(null);
  const freshMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (messages.length === 0) return;
    const ts = (m: ChannelMessage) => new Date(m.createdAt).getTime();
    const track = msgTrackRef.current;
    if (!track) {
      // 首载：全部记为已见，不高亮
      msgTrackRef.current = { ids: new Set(messages.map(m => m.id)), latestTs: ts(messages[messages.length - 1]) };
      return;
    }
    const arrived = messages.filter(m => !track.ids.has(m.id) && ts(m) >= track.latestTs);
    for (const m of messages) track.ids.add(m.id);
    track.latestTs = Math.max(track.latestTs, ts(messages[messages.length - 1]));
    if (arrived.length === 0) return;
    setFreshMsgIds(prev => {
      const next = new Set(prev);
      for (const m of arrived) next.add(m.id);
      return next;
    });
    if (freshMsgTimerRef.current) clearTimeout(freshMsgTimerRef.current);
    freshMsgTimerRef.current = setTimeout(() => setFreshMsgIds(new Set()), 2000);
  }, [messages]);
  useEffect(() => () => { if (freshMsgTimerRef.current) clearTimeout(freshMsgTimerRef.current); }, []);
  return freshMsgIds;
}
