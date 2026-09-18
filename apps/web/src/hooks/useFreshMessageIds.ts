// useFreshMessageIds — 批次 E-3 SSE 新到达消息渐隐高亮的 id 集
// （白名单③状态色切换：accent-dim 底色 → 常态；#548 自 ChannelDetailPage 迁出）。
// 口径 = 全部新到达消息（含自己发送的回显——消息模型只有 authorType 无 authorId，区分不到个人，
// 与 useStreamFollow ownSendPending 窗口同一局限）；首拉与翻页 prepend/水合归并的历史不标
// （createdAt 早于到达前最新一条即历史）。per-id 2s 后移类（各自到达起计，互不重计时），
// 经 .mc-msg 基类过渡渐隐。
// #549：核心机制（id 集 + per-id timer 自清）= utils/freshIds 共享件——与 WU 行侧同一机制，
// 替代本 hook 原「单 timer 全清」实现（fresh 两实现合一）。
import { useEffect, useRef, useState } from 'react';
import type { ChannelMessage } from '../api/channel';
import { createFreshIdTracker } from '../utils/freshIds';

export function useFreshMessageIds(messages: ChannelMessage[]): ReadonlySet<string> {
  const [freshMsgIds, setFreshMsgIds] = useState<ReadonlySet<string>>(new Set());
  const msgTrackRef = useRef<{ ids: Set<string>; latestTs: number } | null>(null);
  // tracker 实例随组件生命周期：useState 懒建一次（onChange 直写 state），卸载 dispose 清计时器
  const [tracker] = useState(() => createFreshIdTracker(setFreshMsgIds));
  useEffect(() => () => tracker.dispose(), [tracker]);
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
    for (const m of arrived) tracker.mark(m.id);
  }, [messages, tracker]);
  return freshMsgIds;
}
