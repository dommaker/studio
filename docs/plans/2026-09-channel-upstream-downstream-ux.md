# Channel 上下游交互与样式优化

> 2026-09-14 立项。用户指令：优化 channel 上下游交互和样式，突出视觉效果、提升效率、降低心智负担。范围经确认为四项全做、一次交付分 Phase commit。

## 痛点（代码证据）

1. `.mc-quote` 引用块纯 div 不可点击（ChannelMessageItem.tsx:211），页面已有 `pageBackToFind` 翻页定位机制未接上。
2. 线程归组只认 `workUnitId && !replyToId` anchor（streamView.ts:82），回复的回复散落主流，普通消息互回不成线程。
3. monitor 告警每条独立整行不可合并（streamView.ts:106 排除系统播报），主流无聚合。
4. 消息仅 ↩/⊕ 两操作、无快捷键；底部 SuggestionChips/agent-ack/reply 预览/输入框四段视觉各自为政。

## AC 摘要

- AC1 quote 点击 → 定位高亮被引用消息（掉出分页自动翻页找，找不到 toast）。
- AC2 任意消息被回复即成线程 anchor；多层回复拍平进线程根；WU anchor/promote/过程折叠不回归。
- AC3 连续 ≥3 条 monitor 告警折叠为摘要行（条数+severity 计数+时间范围），可展开，状态按频道持久化。
- AC4 消息工具条加「复制」；quote 与输入框 reply 预览条可点击定位。
- AC5 j/k 消息焦点导航、r 起回复、Esc 取消 replyTo/焦点；不破坏 mention 弹框与 IME 守卫。
- AC6 底部输入区统一 `.mc-composer-stack` 容器；reply 预览与 quote 同视觉语言。
- AC7 #322 稳定 props 契约不破坏；虚拟滚动/阅读位置/窄屏降级不回归。

## Phase 划分

1. **上游可达**：页面抽 `locateMessage(mid)` 共用函数（?highlight effect 改调它）；quote 改 button 接 `onQuoteClick`；ChannelInput reply 预览条同链路；CSS hover 态。
2. **下游可溯**：`groupIntoThreads` 两遍扫描——anchor 条件放宽 `!replyToId && (workUnitId || hasReplies)`，回复沿链挂最近线程根；`rootAnchorIdOf` 纯函数页面与 streamView 共用。
3. **降噪+操作+快捷键**：`isMonitorAlert` 判定 + 主流连续 ≥3 折叠成 `alert-group` StreamItem（`expandedAlertGroups` 入 usePersistentStreamUI）；复制按钮（clipboard，成功 ✓ 反馈）；useMessageNav（j/k/r/Esc + `.mc-msg-focused` 焦点环 + virtualizer scrollToIndex）。
4. **视觉归组**：`.mc-composer-stack` 容器收纳底部四段；`.mc-input-reply` 视觉对齐 quote；只动 channel 局部类不碰全局 token。

## 验证

每 Phase：相关 vitest 先 RED 后 GREEN + `tsc -b`。收尾：`vitest run --changed origin/master` + typecheck 新鲜输出；逐条 AC 对照；CONTEXT.md 沉淀（线程泛化/告警折叠/快捷键/定位链路）。

## 风险

- 线程泛化改旧归组语义 → 旧测试断言逐条核对后按新语义修正并注明。
- j/k 焦点在虚拟窗口外 → virtualizer.scrollToIndex 优先，scrollIntoView 兜底。
- 告警折叠误伤 → NEED_INPUT 等待中 Studio 消息与无前缀播报排除在外（维持 D-1.5 决策）。
