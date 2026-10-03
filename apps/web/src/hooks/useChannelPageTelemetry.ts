// useChannelPageTelemetry — 频道页进场/渲染埋点（P3-b 自 ChannelDetailPage 切出）：
// #393 saveLastChannelId（/ 与 /channels 重定向落点，spec §2）；
// #520 测量② client.perf 埋点链——③起点 markPageEntry 进页记时（埋点①在 ChannelInput，
// ②起点在 useChannelMessages）；③终点 emitPageFirstRender 首屏消息渲染完成（effect 于提交后跑
// = 渲染已完成；每进页至多一次，空频道不发属正常）；② receipt_render 仅 SSE 到达时标记过的
// 消息发事件（B6：只遍历 freshMsgIds 新到达集，不随 messages O(n) 全量空转——首拉/翻页/水合的
// 历史消息无标记天然跳过）。
import { useEffect } from 'react';
import { saveLastChannelId } from '../utils/lastChannel';
import { markPageEntry, emitPageFirstRender, emitReceiptRendered } from '../utils/clientPerf';
import type { ChannelMessage } from '../api/channel';

export function useChannelPageTelemetry(
  id: string | undefined,
  messages: ChannelMessage[],
  loading: boolean,
  freshMsgIds: ReadonlySet<string>,
) {
  useEffect(() => { if (id) saveLastChannelId(id); }, [id]);
  useEffect(() => { if (id) markPageEntry(id); }, [id]);

  useEffect(() => {
    if (!id || loading || messages.length === 0) return;
    emitPageFirstRender(id);
    if (freshMsgIds.size === 0) return;
    for (const m of messages) {
      if (!freshMsgIds.has(m.id)) continue;
      emitReceiptRendered({ messageId: m.id, channelId: id, workUnitId: m.workUnitId ?? null });
    }
  }, [id, loading, messages, freshMsgIds]);
}
