# web 闸门写路径单模块（2026-09-15）

> 来源：架构评审候选 B1（#545）grilling 定案。
> 状态：**accepted**（#545 已落地：utils/gateWriter.ts + WuGateActions 直消费 + 五宿主重接）。

## 背景

闸门动作（reviewPassed / reviewRejected / confirmPending→transitionStatus）的写路径 =「一次 API 调用 + 响应体写回宿主状态 + SSE 兜底」，五处宿主各抄一份、写回机制三样并存：ChannelDetailPage（channelWorkStore.applyGateResult 直替）、WorkUnitDrawer（setWu 本地直替）、WorkUnitDetailPage（reloadWu 全量重拉）、WorkUnitListPage（workunitStore 三动作 + loadWorkUnits 全量重拉）、DeliveryPanel（onRefresh 刷 PMO 台账）。WuGateActions 是共享壳，但写路径刻意经 props 注入（E2-4 当时决策）——响应加一个字段要动五处。

## 决策

1. **唯一写模块 = 纯函数核心**（非 hook、非组件内置）：调闸门 API → 响应快照落点分发。WuGateActions 组件直接消费（onReviewPassed / onReviewRejected / onConfirmPending 三个注入 props 删除），DeliveryPanel 直调同一核心。
2. **落点集合（冻结契约）**：响应快照双写——`channelWorkStore.applyWorkunitSnapshot(wu.channelId, wu)` + `markSuggestionsDirty(channelId)`（精确镜像 useChannelWorkStoreSync 对 status_changed 的路由）+ `workunitStore.applyWorkunitEvent(wu, { insertIfMissing: false })`（仅存量行 upsert；闸门作用于已存在 WU，不插行）。主动写（API 响应，本票）与被动写（SSE 事件，#549）收敛到同一组 store action——这就是「单份 upsert」的完整含义。
3. **宿主本地落点 = 单一可选 sink `onUpdated?(wu)`**：store 写完后调用。drawer 的 setWu、详情页本地 wu、PMO 的 onRefresh 都在各自 onUpdated 里做。错误 rethrow——toast / 弹窗错误展示留在 WuGateActions 与 DeliveryPanel（现状各自内聚，不搬家）。
4. **旧路径全删不留委托**：workunitStore 的 reviewPassed / reviewRejected / confirmPending（API + 全量重拉三件套）、channelWorkStore.applyGateResult（applyWorkunitSnapshot 的裸副本，统一走后者，顺带白赚坏负载守卫）。ListPage 闸门动作从全量重拉变存量行 upsert（页码/total 不重算；SSE 兜底与重连 refetch 不变）——此行为变化即收口本体。
5. **B1/B5 分工**：B1（#545）= 主动写路径；B5（#549）= 被动写路径（SSE 接线收口）+ ListPage/AuditLogsPage 页面收口。两票并行可做（动 ListPage 不同区域），实际撞车退化为 B5 先。两票 brief 均以本 ADR 决策 2 为落点口径——先做完的不锁死另一个。

## 否决的备选（勿再提）

- **hook 壳**：DeliveryPanel 在事件回调里调（非渲染期），hook 覆盖不了；4/5 宿主本就经 WuGateActions 渲染。
- **WuGateActions 保留可选 handler override**：无 override 场景，留着 = 双路径。
- **单写一个 store + 靠 SSE 兜底**：SSE 断连窗口内无落点，且与被动写口径分叉。
- **onUpdated + onSettled 双 sink**：PMO 刷新在 onUpdated 里顺手做，一个够。
- **旧 store 动作留薄委托**：留双路径，违 no_facade_without_migration。

## SSE 双保险保持

闸门 API 后 status_changed 事件照常到达（E2-4 决策 8 口径），与响应体写回同构 upsert 幂等（markSuggestionsDirty 双触发由 store 既有防抖窗口合并）；写模块不依赖 SSE 在场，SSE 也不取代响应体写回。重连 refetch 自愈不变。
