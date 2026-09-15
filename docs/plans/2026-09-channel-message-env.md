# ChannelMessageItem 公开 Props 收口（#547）

来源：2026-09-15 架构评审候选 B3，grilling 四议题已决（结论钉死在 #547 票体 Agent Brief，本文件只做执行分解，不重复决策）。

## 决策摘要（票体为准）

- 11 个横切值收走：`onAction`/`onReply`/`findMessage`/`channelId`/`onOpenWorkUnit`/
  `onOpenWorkUnitConfirm`/`onOpenWorkUnitRuling`/`onOpenRequirement`/`onInlineReply`/`onQuoteClick`
  经新增 `ChannelMessageEnv` React Context（单 Provider，挂频道页装配层）下发；
  `fileVocabulary` 不进 Context，消息项直接 `useChannelDataStore` selector 自取。
- 5 个 per-message 派生值留 props：`waitingForInput`/`wuChangedFiles`/`highlight`/`fresh`/`focused`
  （boolean 翻牌只命中个别消息，memo 友好）。高频 volatile id 集禁止进 Context value。
- 6 个结构 props 留但封闭：`isThreadAnchor`/`threadReplyCount`/`isExpanded`/`onToggleThread`/
  `compact`/`isThreadReply`；`ChannelStreamBody` 的 extra 从 `Partial<Props>` 收紧为这 6 键的封闭 `Pick`。
- #322 契约维持：`React.memo` 保留；env value 全部由稳定引用组成（useMemo 组装），
  identity 不变 = 零重渲扇出；render-count 测试保持绿 + 新增翻牌零扇出断言。

## 执行步骤

1. RED：新测试——store 自取 fileVocabulary 染 chip、highlight/fresh/focused 类断言（消息项级）、
   页面级 focus 翻牌只重渲命中项。
2. 新增 `components/channel/ChannelMessageEnv.tsx`（interface + Provider + hook）。
3. `ChannelMessageItem` Props 收窄为 message + 5 派生 + 6 结构（导出 `ChannelMessageItemProps`），
   横切值改 `useChannelMessageEnv()` + store 自取。
4. `ChannelStreamBody`：`StreamMessageExtra` 封闭 Pick 替换 `Partial<ComponentProps<…>>`。
5. `ChannelDetailPage`：useMemo 组 env value + Provider 包 `ChannelStreamBody`；
   renderMessageItem 手喂 ≤6 prop，依赖数组 16→5；删页面 fileVocabulary 订阅（ensure 拉取保留）。
6. 8 个消息项测试文件迁移到 Provider 包裹。
7. 验证：web 相关测试全绿 + tsc + lint；更新 `apps/web/src/CONTEXT.md`。

## 边界（Out of scope）

- deriveStreamView / useChannelStream 渲染管线不动；姊妹票 #546/#548/#549 不做；
  5 个派生值不搬 Context；不单独落 ADR。
