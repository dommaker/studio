// #545（ADR 2026-09-15-web-gate-write-module，架构评审候选 B1）：WU 闸门写路径唯一正本——
// 「闸门转移 = 一次 API 调用 + 响应体 WU 快照双写落点」。此前同一行为在五处各抄一遍
// （ChannelDetailPage 工作条 / WorkUnitDrawer / WorkUnitDetailPage / workunitStore 动作 / DeliveryPanel），
// confirm 载荷加一个字段要动五处；收口后动作签名单点承载（leverage）。
// 落点集合（ADR 决策 2 冻结契约，精确镜像 useChannelWorkStoreSync 对 status_changed 的路由）：
// channelWorkStore.applyWorkunitSnapshot + markSuggestionsDirty + workunitStore.applyWorkunitEvent
// （仅存量行 upsert——闸门作用于已存在 WU，不插行）。主动写（本模块）与被动写（SSE，#549）同口径。
// 宿主本地落点 = 单一可选 sink onUpdated（drawer/详情页的 setWu 等）；错误 rethrow，
// toast/弹窗错误展示留在 WuGateActions 与 DeliveryPanel。纯函数核心，非 hook（ADR 决策 1）。
import { workunitApi, type ReviewConfirmPayload, type WorkUnit } from '../api/workunit';
import { useChannelWorkStore } from '../stores/channelWorkStore';
import { useWorkUnitStore } from '../stores/workunitStore';

/** 宿主本地落点（ADR 决策 3）：store 双写完成后调用；缺省 = 宿主无需本地快照（列表行/工作条） */
export type GateUpdateSink = (updated: WorkUnit) => void | Promise<void>;

async function settle(call: Promise<{ data: WorkUnit }>, onUpdated?: GateUpdateSink): Promise<WorkUnit> {
  const wu = (await call).data; // 失败时异常先行——任何落点都不会被污染快照
  if (wu.channelId) {
    useChannelWorkStore.getState().applyWorkunitSnapshot(wu.channelId, wu);
    useChannelWorkStore.getState().markSuggestionsDirty(wu.channelId);
  }
  useWorkUnitStore.getState().applyWorkunitEvent(wu, { insertIfMissing: false });
  await onUpdated?.(wu);
  return wu;
}

export interface GateWriter {
  /** 审查硬门通过（confirm 结构化评审载荷原样透传，#463 契约不变） */
  reviewPassed: (id: string, summary?: string, assigneeId?: string, confirm?: ReviewConfirmPayload) => Promise<WorkUnit>;
  /** 审查硬门拒绝（reason 可选） */
  reviewRejected: (id: string, reason?: string) => Promise<WorkUnit>;
  /** #284 pending 人闸确认（→ unassigned 进 frontier 可认领） */
  confirmPending: (id: string) => Promise<WorkUnit>;
}

export function createGateWriter(onUpdated?: GateUpdateSink): GateWriter {
  return {
    reviewPassed: (id, summary, assigneeId, confirm) => settle(workunitApi.reviewPassed(id, summary, assigneeId, confirm), onUpdated),
    reviewRejected: (id, reason) => settle(workunitApi.reviewRejected(id, reason), onUpdated),
    confirmPending: (id) => settle(workunitApi.transitionStatus(id, 'unassigned'), onUpdated),
  };
}
