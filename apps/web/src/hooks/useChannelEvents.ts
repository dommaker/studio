// Channel SSE hook — B2: EventSource 实时推送替代 3s 轮询
// #313：首拉 / SSE 断开 10s 兜底 / visibility 门禁统一收敛到 useGatedPoll
// #548：messages 数据面收编 channelMessageStore（ADR 2026-08-31 模式延伸）——
// 本 hook 退为薄接线：状态全在 store（per-channelId 切片），此处只保留
// 取数时机（useGatedPoll/频道切换重拉）与 SSE 订阅路由；对外契约形状不变。
import { useEffect, useCallback, useRef } from 'react';
import { type ChannelMessage, type FileRef } from '../api/channel';
import { useWebSocketContext } from '../api/websocketHooks';
import { useGatedPoll } from './useGatedPoll';
import { useChannelMessageStore, type MessageUpdatedPayload } from '../stores/channelMessageStore';
import type { PruneOptions } from '../utils/messagePruning';

/** 缺键（未加载）时的稳定空列表——防下游 memo 因每渲染新引用失效 */
const EMPTY_MESSAGES: ChannelMessage[] = [];

export interface UseChannelMessagesOptions {
  /** #326：降级/水合阈值覆盖（测试用小参数；缺省 = messagePruning 常量） */
  prune?: Partial<PruneOptions>;
}

export function useChannelMessages(channelId: string | undefined, options?: UseChannelMessagesOptions) {
  const { onEvent } = useWebSocketContext();
  const slice = useChannelMessageStore(s => (channelId ? s.channels[channelId] : undefined));
  // 缺键 = 首拉进行中：loading 初值 !!channelId（对齐收编前 useState 初值语义）；
  // 切换频道旧切片数据保留到新数据到达，不做清空（per-channelId 切片天然承载）
  const messages = slice?.messages ?? EMPTY_MESSAGES;
  const loading = slice?.loading ?? !!channelId;
  const error = slice?.error ?? null;
  const hasMore = slice?.hasMore ?? false;

  const fetchMessages = useCallback(async () => {
    if (!channelId) return;
    await useChannelMessageStore.getState().fetchMessages(channelId);
  }, [channelId]);

  // #313：挂载首拉 + SSE 断开 10s 兜底 + visibility 门禁统一走 useGatedPoll
  // （fetchMessages 自带 channelId 空值守卫）
  useGatedPoll(fetchMessages, 10000);

  // 频道切换：loading/error 复位 + 立即重拉（挂载首跳已由 useGatedPoll 首拉覆盖，本 effect 跳过挂载）
  const prevChannelRef = useRef(channelId);
  useEffect(() => {
    if (prevChannelRef.current === channelId) return;
    prevChannelRef.current = channelId;
    if (!channelId) return;
    useChannelMessageStore.getState().beginLoad(channelId);
    void Promise.resolve().then(fetchMessages);
  }, [channelId, fetchMessages]);

  // B2: SSE 实时推送替代轮询——逐条直写 store（写批处理已裁决不做，见 #548 票体）
  useEffect(() => {
    if (!channelId) return;
    const unsub = onEvent((msg) => {
      if (msg.event_type === 'channel.message_sent') {
        const data = msg.data as { channelId?: string; message?: ChannelMessage };
        if (data?.channelId === channelId && data?.message) {
          useChannelMessageStore.getState().applyMessageSent(channelId, data.message);
        }
      } else if (msg.event_type === 'channel.message_updated') {
        const data = msg.data as ({ channelId?: string } & MessageUpdatedPayload) | undefined;
        if (data?.channelId === channelId) {
          useChannelMessageStore.getState().applyMessageUpdated(channelId, data);
        }
      }
    });
    return unsub;
  }, [channelId, onEvent]);

  // #486：乐观回显本体在 store action（pending 插入 / 成功原位替换 / 失败回滚上抛）；
  // ChannelInput 回灌草稿 + toast 的既有路径不变
  const sendMessage = useCallback(async (content: string, replyToId?: string, files?: FileRef[]) => {
    if (!channelId) return null;
    return useChannelMessageStore.getState().sendMessage(channelId, content, replyToId, files);
  }, [channelId]);

  // #290（清单 #22）：返回是否真实前插（供调用方在失败/无更多时清理行锚点，防视口乱跳）
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (!channelId) return false;
    return useChannelMessageStore.getState().loadMore(channelId);
  }, [channelId]);

  // #326 数据层降级（ADR 2026-08-25）：syncPruning 由渲染侧在首个可见消息变化时调用；
  // 判定/防抖/水合全在 store（prune 阈值覆盖经 ref 透传，防每渲染换引用重挂）
  const pruneOptsRef = useRef(options?.prune);
  pruneOptsRef.current = options?.prune;
  const syncPruning = useCallback((anchorMid: string | null) => {
    if (!channelId) return;
    useChannelMessageStore.getState().syncPruning(channelId, anchorMid, pruneOptsRef.current);
  }, [channelId]);

  return { messages, loading, error, hasMore, sendMessage, loadMore, refresh: fetchMessages, syncPruning };
}
