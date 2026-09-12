# 复核：前端频道性能治理成果是否仍有空洞（#512）

日期：2026-09-12 · 复核范围：apps/web/src 频道相关渲染面与取数面（#322/#325/#326/#328/#403/#486 治理组合）

## 结论

**有空洞，1 条实质发现**（取数纪律未覆盖行动中心 store 的 SSE 触发重拉），另确认 2 处「虚拟化/水合覆盖不到」的视图属已接受边界而非缺陷。memo 边界（#322 纪律）在治理后新增的组件上无违规。除发现 1 外不建议新开实现票——发现 1 是否立项由 map 维护方裁决。

## 发现

### F1（实质）：notificationStore.load() 无 TTL/single-flight/seq 守卫，且被 SSE 事件逐条直触全量重拉

- `stores/notificationStore.ts:127-137` — `load()` 裸发 `GET /action-center`，无任何纪律：无 TTL 锚点、无 single-flight（并发事件 → 在途重叠多份）、无 seq 守卫（整体替换语义下晚到的旧响应可覆盖新状态，下一次事件前 UI 呈旧值）。
- `components/NotificationBell.tsx:103-116` — 每条 `workunit.status_changed`（全频道、每次 WU 状态流转）与每条 atHuman `channel.message_sent` 都 `void load()`，无防抖无合并。对照：同一事件风暴面在建议端点重拉上已做 trailing 防抖（`pages/ChannelDetailPage.tsx:46-49` #489，`SUGGESTIONS_RELOAD_DEBOUNCE_MS`），行动中心这条路径漏掉了同等处理。
- 频道相关性：该 store 的 `stateItems` 是频道页顶栏 NEED_INPUT chip 的唯一数据源（`pages/ChannelDetailPage.tsx:184-189` waitingWus 投影），属于票面所问「频道相关 store」。
- 影响面：多 agent 活跃期 WU 状态流转连发时，每个流转 = 一次行动中心全量派生查询；并发在途 + 旧响应晚到可致短暂陈旧。严重度中低（流转是秒级人文节奏，非 chunk 级），但这是 #403 纪律组合里唯一漏管的频道相关取数面。
- 修复方向（供裁决，不在本票实施）：`load()` 接 `stores/fetchDiscipline.ts` 底座（全局单份簿记，照 rosterStore 模式），或在 NotificationBell 触发侧加 #489 同款 trailing 防抖 + single-flight。

## 边界确认（覆盖不到但判定为已接受边界，非缺陷）

### B1：右栏「频道动态」未虚拟化

- `components/channel/ChannelActivityRail.tsx:269-292` — REQ 卡按 `reqs.map` 全量渲染，无窗口化；卡下动态行每卡截断 3 条（:285），「其他动态」经 `deriveActivityRows` 同类相邻折叠（:263）。
- 判定依据：整栏已 memo 化且只吃稳定投影（:219 + `hooks/useActivityMessageItems.ts:12-20` 引用稳定契约 + 卡内静态部分 `ReqCardStatic` memo :141），无关增量不触重渲；渲染成本 O(频道 REQ 数)，频道 REQ 量级为数十，线性可承受。**边界条件**：单频道 REQ 数涨到数百级时挂载成本线性增长，届时需再评估。

### B2：展开线程的回复在单个虚拟行内全量渲染

- 线程是虚拟化的 item 单位（`utils/streamVirtual.ts:89-103` anchor+全部 replies 映射同一虚拟行），行内不再窗口化：`pages/ChannelDetailPage.tsx:857-877` 展开线程的 replies 全量进 DOM。
- 缓解已在：≥3 条连续过程消息默认折叠成组（`utils/streamView.ts:125-149`），长线程的主体（过程消息）不进 DOM。
- **边界条件**：数百条里程碑级回复（人类/卡片/等待回复）的极端线程仍全量渲染，概率低，不立项。

## 核查无发现的面（证据）

### 虚拟化/水合覆盖（#325/#326）

- 主流+线程统一走 `deriveStreamView` items → virtualizer 窗口渲染（`pages/ChannelDetailPage.tsx:653-700,997-1004`）；线程视图在覆盖内（见 B2 的行内边界）。
- 降级/水合按首个可见消息锚定（`utils/messagePruning.ts:58-77`，keepRecent=100/降级距 50/水合距 30 迟滞）；水合防抖 + in-flight 重排 + 频道切换清计时器（`hooks/useChannelEvents.ts:195-224`）。
- 降级区是前缀性质 → 线程 reply 降级蕴含 anchor 降级 → 整线骨架行兜底（`pages/ChannelDetailPage.tsx:838-841`），不存在「半水合线程」渲染洞。
- 搜索/跳转场景：产品无频道内消息搜索功能（grep 全仓仅 Knowledge/Library 搜索）；跳转（`?highlight=`）覆盖完整——翻页定位循环上限 10 页 + toast 终局反馈（`pages/ChannelDetailPage.tsx:553-569,608-634`）、目标掉出窗口走 `virtualizer.scrollToIndex`（:761-765）、先解钉防振荡（:756）、骨架目标同样高亮（:827-832）。

### memo 边界外重渲染路径（#322 纪律）

- `ChannelMessageItem` memo + 稳定 props 契约保持完好：`handleAction` 经镜像 ref 稳身份（`hooks/useChannelCardActions.ts:27-28`）、`findMessage` 同法（`pages/ChannelDetailPage.tsx:359-363`）、`renderMessageItem` 的 deps 在消息到达时不变（:801-821）。
- 治理后新增组件核查：`ChannelActivityRail` memo（#416，:219）+ 投影稳定；`ChannelWorkBar` 自持有 live 订阅，step 事件只重渲自身边界（`components/channel/ChannelWorkBar.tsx:64-65` + `hooks/useChannelLiveExecutions.ts`）；`ChannelInput` 派生全 memo 化、store 订阅按 key 切片（`components/channel/ChannelInput.tsx:60-71,102-142`），页面随消息到达重渲时这些组件的增量 diff 均为廉价路径，无 memo 破口。
- 页面级重渲（messages setState → ChannelDetailPage 重渲）是架构内禀，被治对象（消息项）已被 memo + 稳定引用保护，未发现新组件把不稳定引用/内联闭包传进 memo 化消息项。

### 取数纪律（#403）在其余 store 的遵守情况

- 已接 `fetchDiscipline` 底座（TTL/single-flight/seq/inflight 生命周期）：`stores/channelDataStore.ts:78,100,122`（词表/PMO/成员三切片按 channelId 粒度）、`stores/requirementChainStore.ts:77`（per-reqId）、`stores/pmoDataStore.ts:72,93`、`stores/rosterStore.ts:96,119`。
- 纯本地无取数、无需纪律：`stores/unreadStore.ts`（SSE 增量计数）、`stores/rosterActivityStore.ts`（chunk 下沉）。
- `stores/workunitStore.ts` 属 WU 列表页面（非频道面），`loadMoreWorkUnits` 有 loading 在途守卫（:124-126），不在本票范围。
- SSE 有序合并（#328）：refetch 合并 `mergePage` prepend 历史页不丢（`hooks/useChannelEvents.ts:22-31`）；乐观回显（#486）pending 即插/原位替换/失败回滚（:144-166），游标取最老非 pending 防翻空页（:171-173）。
