// useWorkUnitStoreSync — workunitStore 的 SSE 被动写收口（#549，架构评审候选 B5）
// 形状对标 useChannelWorkStoreSync（#528）：模块级 handleEvent 路由 + useDataPlaneSync 承接重连。
// 此前同一事件三套独立接线（ListPage 内联 onEvent + 手写 upsert/fresh 高亮、WuDetail 内联直替、
// channel 域 sync hook 除外）收敛为唯一一份路由：
//   status_changed → applyWorkunitEvent(insertIfMissing:false)（存量行直替/过滤移除 + detail slice 就地 upsert）
//   created        → applyWorkunitEvent(insertIfMissing:true) + markWuFresh（fresh 渐隐高亮集合）
//   workunit:removed（#538）→ removeWorkunit
// 与 B1 主动写（gateWriter 响应体双写）同口径——同一组 store action 是「单份 upsert」的完整含义
// （ADR 2026-09-15-web-gate-write-module 决策 2）。
// 挂载点：App 级单点（App.tsx WebSocketProvider 内，同 useRequirementChainStoreSync 位置）。
// 重连兜底门槛 = store listOnScreen（#557 真实在屏信号，WorkUnitListPage 挂载/卸载维护）——
// 空列表代理已废：用户坐在 ListPage 但列表为空（过滤无结果/首拉失败留空）时重连照刷，
// 复原 #549 收口前页面级 onReconnect 无条件重拉的语义；不加轮询（pollIntervalMs=0 停用，维持现状）。
import { type WebSocketMessage } from '../api/websocketHooks';
import { useWorkUnitStore } from '../stores/workunitStore';
import { useDataPlaneSync } from './useDataPlaneSync';
import type { WorkUnit } from '../api/workunit';

function handleWorkUnitEvent(msg: WebSocketMessage) {
  const store = useWorkUnitStore.getState();

  if (msg.event_type === 'workunit:removed') {
    // #538：负载 { id, channelId }，缺 id 属畸形 fail-closed 跳过
    const data = msg.data as { id?: string } | null | undefined;
    if (typeof data?.id === 'string' && data.id) store.removeWorkunit(data.id);
    return;
  }

  if (msg.event_type !== 'workunit.status_changed' && msg.event_type !== 'workunit.created') return;
  // 负载 = { workunit } 信封全量快照（同 workunitApi.get 形状）；缺 workunit 属畸形跳过
  const wu = (msg.data as { workunit?: WorkUnit | null } | null | undefined)?.workunit;
  if (!wu) return;
  store.applyWorkunitEvent(wu, { insertIfMissing: msg.event_type === 'workunit.created' });
  if (msg.event_type === 'workunit.created') store.markWuFresh(wu.id);
}

/** 引用稳定（useDataPlaneSync 的 effect 依赖要求）：重连兜底仅在列表页在屏时刷（#557） */
function workUnitEnsureFresh(): Promise<void> {
  const store = useWorkUnitStore.getState();
  if (!store.listOnScreen) return Promise.resolve();
  return Promise.all([
    store.loadWorkUnits(),
    store.loadUnattributedCount(),
    store.loadAllCount(),
  ]).then(() => undefined);
}

export function useWorkUnitStoreSync(): void {
  useDataPlaneSync({
    handleEvent: handleWorkUnitEvent,
    ensureFresh: workUnitEnsureFresh,
    pollIntervalMs: 0, // 不加轮询（维持现状）——取数时机 = SSE 路由 + 重连强刷 + 页面操作
  });
}
