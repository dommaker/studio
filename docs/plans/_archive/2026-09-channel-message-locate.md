# #530 useMessageLocate：mid→可见 完整语义一个入口

> 来源：studio#530（2026-09-14 架构评审「channel 性能方向」候选 2，紧随 #528）。
> 目标：「定位到一条消息」从 3 文件/4 ref/2 effect 收成 `hooks/useMessageLocate.ts` 一个模块；
> quote 引用块 / chip 提问定位 / `?highlight` 直达三条调用链退化为三行调用。

## 新建 `apps/web/src/hooks/useMessageLocate.ts`

页面现有零件（全部内化，PURE_MOVE 语义不变）：`HIGHLIGHT_LOCATE_MAX_PAGES`、`locateSnapshotRef`、
`pageBackToFind`、`ensureThreadExpanded`/`expandThreadOf`（根锚解析 `rootAnchorIdOf` 行为不变）、
`locatingMidRef`/`chipLocatingRef` 防重入台账、`highlightId` state + 高亮 effect（unpin →
scrollIntoView/virtualizer.scrollToIndex → 2s 消退）、toast 兜底。

- **入参**：`messages/hasMore/loadMore`（ref 镜像内化）、`setCollapsedThreads`（展开线程唯一写口）、
  `unpinFromBottom`（useStreamFollow 提供，模块负责调用时机——高亮 effect 内调用，时机同现状）、
  `streamRef/virtualizer/virtualEnabled/messageToItemIndex`（滚动定位）。
- **接口**（interface 即测试面）：
  - `locate(mid)`：已加载 → 展开所在收起线程 + 高亮；未加载 → #439 翻页定位循环
    （上限 HIGHLIGHT_LOCATE_MAX_PAGES 页），翻到底/超限/无新内容 → toast 兜底不静默。
  - `locateBy(key, find)`：locate 的泛化——chip 定位的 wuId→mid 解析（`latestQuestionMessageOf`）
    在翻页期间要按新快照重评估，纯 mid 入参表达不了；`locate(mid)` 内部即 `locateBy` 特化。
  - 返回 `highlightId`（渲染通道 `highlight={highlightId === msg.id}` 与骨架行高亮仍需要）。
- **防重入**：单台账本 `inFlightRef`（同 key 重入跳过、不同 key 后到者赢旧循环 cancelled）。
  原双台账（mid/chip 可并发）合并——两个翻页循环共享翻页游标互踩没意义，单飞是刻意收严（见边界 3）。

## 页面退化（ChannelDetailPage.tsx）

删：上述全部零件 + 高亮 effect。
留/改：
- `locateWaitingQuestion(wuId)` → `locateBy(\`wu:${wuId}\`, msgs => latestQuestionMessageOf(msgs, wuId))`
  （`latestQuestionMessageOf` 留页面，chip 的 wu 语义不进模块）。
- `onQuoteClick` / `onReplyPreviewClick` → 直传 `locate`。
- `?highlight` effect 保留 URL 参数消费生命周期（`highlightConsumedRef`、loading 等待），
  定位动作改调 `locate(mid)`——三行。
- 键盘导航 `scrollToFocusedMessage` 不动（它不是 locate 链，仍直接用 useStreamFollow 的 unpin）。

## 边界（勿扩 scope）

1. useStreamFollow 底座不动（unpin 仍由它提供，模块只负责调用时机）。
2. `rootAnchorIdOf`/`expandThreadOf` 既有行为不变（含多层线程根解析）。
3. 防重入从「mid/chip 双台账并发」收严为「单飞 + 后到者赢」——并发翻页循环互踩是有意消除。
4. `latestQuestionMessageOf`（wu→最新提问 mid 口径）留页面，不进模块。
5. 高亮视觉通道（renderMessageItem/骨架行的 `mc-msg-highlight`）不动。

## 验证

- `hooks/__tests__/useMessageLocate.test.ts`（TDD：先 RED 后 GREEN，renderHook 模式仿 useMessageNav.test）：
  已加载直接定位（展开线程+高亮+unpin+不翻页）/ 多层线程根解析 / 翻页定位命中 /
  翻到底 toast 兜底 / 防重入（同 key 跳过、后到者赢）/ 2s 消退。
- 既有 `ChannelDetailPage-quote-locate.test.tsx` 等页面测试零改动转绿（行为保持）。
- `vitest run --changed origin/master` + typecheck。
- `apps/web/src/CONTEXT.md` 补 useMessageLocate 条目。
