// #416 消息摘要投影 hook：全量消息 → 右栏消费的最小条目集（projectActivityMessages）。
// 引用稳定是核心契约：投影内容未变（人类插话、无 WU 普通 agent 消息等无关增量）时复用旧引用，
// memo 化的 ChannelActivityRail 与下游 useMemo 不破裂；相关增量到达时换引用正常传播。
import { useMemo, useRef } from 'react';
import type { ChannelMessage } from '../api/channel';
import {
  activityMessageItemsEqual,
  projectActivityMessages,
  type ChannelActivityItem,
} from '../components/channel/activityRail';

export function useActivityMessageItems(messages: ChannelMessage[]): ChannelActivityItem[] {
  const stableRef = useRef<ChannelActivityItem[]>([]);
  return useMemo(() => {
    const next = projectActivityMessages(messages);
    if (activityMessageItemsEqual(stableRef.current, next)) return stableRef.current;
    stableRef.current = next;
    return next;
  }, [messages]);
}
