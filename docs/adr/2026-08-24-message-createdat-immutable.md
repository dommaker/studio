# 消息 createdAt 不可变（2026-08-24）

> 来源：#317（#315 code review 发现的后续决策票），经 grilling 决策树确认。
> 状态：**active**（2026-08-24 实施收尾）。

## 背景

`ChannelMessageService.updateMessageMeta` / `updateMessage` 追加更新行时把 `createdAt` 重置为当前时刻（append-only JSONL 后写胜出，bump 生效）。后果：SSE 原位替换（#315）保持旧位置，REST 刷新按新 createdAt 重新归位——同一消息两条路径位置不同；极端时 anchor bump 越过自身 reply，刷新后 `groupIntoThreads` 单遍归组破坏（#287 走查 F17 同类症状）。

triage 核查确认 bump 无任何消费方受益：频道列表不按消息活跃度排序，未读计数仅由 `channel.message_sent` 驱动，`preferenceObserver` 只在创建路径消费 createdAt。bump 是追加新行时顺手写 now 的副作用，非有意设计。

## 决策

**`createdAt` = 消息诞生时刻，写入后不可变。** 更新（meta 合并、内容编辑）只改对应字段，消息在所有排序/归组/日期分隔中保持原位置。「messages 恒按 createdAt 升序」不变式（#287）由消费端努力维持升级为生产侧保证。

不引入 `updatedAt` 字段（当前无消费方，YAGNI；将来需要时 JSONL 加字段 additive、零迁移）。历史数据不迁移——已被 bump 的旧行保持现状（仅历史显示位置，无数据正确性风险）。

## 否决的备选

- **方向 2（消费端按新 createdAt 重归位）**：SSE 与刷新一致了，但会话内消息跳动，且 anchor bump 越过 reply 时线程归组在实时会话中当场破坏——把 F17 从刷新路径搬进 SSE 路径，更糟。
- **方向 3（接受差异并文档化）**：零改动但留 F17 同类雷；卡片决策回写是高频 bump 源，雷会被反复踩。

## 衔接

与 ADR 2026-08-24 D1/D2（SSE 事件负载契约，#311/#315）配套：D1/D2 解决「消费端读到什么」，本决策解决「读到的本体在时序上的位置语义」。
