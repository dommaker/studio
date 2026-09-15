// 频道消息列表纯函数（#548 自 useChannelEvents 抽取，与 messagePruning 同层）：
// store（channelMessageStore）与测试共用；语义与抽取前逐字节一致。
import type { ChannelMessage } from '../api/channel';

/** #287（清单 P2 #19）：增量到达按 createdAt 升序归位 + id 去重。
 *  下游 groupIntoThreads 单遍归组要求 anchor 先于 reply 出现；一律 push 尾部会让
 *  乱序/孤儿到达的线程回复滞留主流（走查 F17：同一消息刷新前后两种位置）。
 *  有序插入后，任意到达路径下的顺序与刷新全量列表一致，孤儿回复在 anchor 到达时归并。 */
export function insertMessage(prev: ChannelMessage[], msg: ChannelMessage): ChannelMessage[] {
  if (prev.some(m => m.id === msg.id)) return prev;
  const t = new Date(msg.createdAt).getTime();
  let idx = prev.length;
  while (idx > 0 && new Date(prev[idx - 1].createdAt).getTime() > t) idx--;
  return [...prev.slice(0, idx), msg, ...prev.slice(idx)];
}

/** #328：refetch 合并——最新一页按 id 归并进现有列表：已存在的以服务端版本刷新，
 *  新消息按 createdAt 有序插入，已 prepend 的历史页原样保留。 */
export function mergePage(prev: ChannelMessage[], page: ChannelMessage[]): ChannelMessage[] {
  const fresh = new Map(page.map(m => [m.id, m]));
  const prevIds = new Set(prev.map(m => m.id));
  let next = prev.map(m => fresh.get(m.id) ?? m);
  for (const m of page) {
    if (!prevIds.has(m.id)) next = insertMessage(next, m);
  }
  return next;
}
