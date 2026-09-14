// useChannelWorkStoreSync — channelWorkStore 的实时接线（#528，机制照 useRosterStoreSync）
// 与 App 级单点的 chain 接线不同：本 hook 挂 ChannelDetailPage 页面级（ref-count=1），
// 「活跃频道」由挂载方经模块级 activeChannelId 告知——SSE 事件只路由活跃频道（对齐旧页面过滤语义），
// 挂载即打底三 slice（wus/reqs TTL 门禁 + suggestions 即时），重连全 slice 强刷（useDataPlaneSync 承担）。
// 更新逻辑唯一一份在 store action；本 hook 只做事件路由与活跃频道登记。
import { useEffect } from 'react';
import { type WebSocketMessage } from '../api/websocketHooks';
import { parseRequirementPayload } from '../stores/channelWorkStore';
import {
  useChannelWorkStore,
  CHANNEL_WORK_POLL_INTERVAL_MS,
} from '../stores/channelWorkStore';
import { useDataPlaneSync } from './useDataPlaneSync';
import type { WorkUnit } from '../api/workunit';

// 活跃频道登记（模块级）：页面级单消费方（ref-count=1），handleEvent/ensureFresh 引用稳定靠它取当前频道
let activeChannelId: string | null = null;

function handleChannelWorkEvent(msg: WebSocketMessage) {
  const id = activeChannelId;
  if (!id) return;
  const store = useChannelWorkStore.getState();

  if (msg.event_type === 'workunit.status_changed') {
    // 负载 = { workunit } 信封 17 字段全量快照（snapshotToData）；非本频道跳过（对齐旧过滤语义）
    const wu = (msg.data as { workunit?: WorkUnit | null } | null)?.workunit;
    if (!wu || wu.channelId !== id) return;
    store.applyWorkunitSnapshot(id, wu);
    // #443/#489：状态变化（含 NEED_INPUT 挂起/恢复）后端点派生建议防抖重拉
    store.markSuggestionsDirty(id);
    return;
  }

  if (msg.event_type === 'requirement.created' || msg.event_type === 'requirement.updated') {
    const req = parseRequirementPayload(msg.data);
    if (!req) return;
    // 负载带 channelId → 按频道过滤；缺省（防御）放行
    if (req.channelId && req.channelId !== id) return;
    store.applyRequirementEvent(id, msg.event_type === 'requirement.created' ? 'created' : 'updated', req);
    // #489：REQ 创建/更新同样改变建议推导输入 → 防抖重拉（与 status_changed/message_sent 共享窗口）
    store.markSuggestionsDirty(id);
    return;
  }

  if (msg.event_type === 'channel.message_sent') {
    // 负载缺 channelId 属畸形，fail-closed 跳过（与 useChannelEvents 同口径）
    const data = msg.data as { channelId?: string } | undefined;
    if (data?.channelId === id) store.markSuggestionsDirty(id);
  }
}

/** 引用稳定（useDataPlaneSync 的 effect 依赖要求）：频道工作面的统一取数入口（活跃频道） */
function channelWorkEnsureFresh(opts?: { maxAgeMs?: number }): Promise<void> {
  const id = activeChannelId;
  if (!id) return Promise.resolve();
  return useChannelWorkStore.getState().ensureChannelWork(id, opts);
}

export function useChannelWorkStoreSync(channelId: string | undefined): void {
  // 活跃频道登记 + 挂载打底：wus/reqs（TTL 门禁，切频道 TTL 内零重拉）+ suggestions 即时
  useEffect(() => {
    activeChannelId = channelId ?? null;
    if (!channelId) return;
    const store = useChannelWorkStore.getState();
    void store.ensureChannelWork(channelId);
    void store.refreshSuggestions(channelId);
    return () => { if (activeChannelId === channelId) activeChannelId = null; };
  }, [channelId]);

  useDataPlaneSync({
    handleEvent: handleChannelWorkEvent,
    ensureFresh: channelWorkEnsureFresh,
    pollIntervalMs: CHANNEL_WORK_POLL_INTERVAL_MS,
  });
}
