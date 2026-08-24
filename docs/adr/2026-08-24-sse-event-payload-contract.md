# SSE 事件负载契约（2026-08-24）

> 来源：架构评审「studio 性能优化方向」候选 2 的 grilling 决策树（计划：docs/plans/2026-08-sse-event-payload-deepening.md），全树经所有者确认。
> 状态：**active**（2026-08-24 实施收尾，验证：vitest --changed 749 passed + tsc-gate 绿）。

## 背景

SSE 事件曾长期处于「门铃」形态：负载只够通知「有事发生」，消费端无法就地更新，每条事件触发 REST 补拉——事件越多 REST 越多，事件总线的杠杆为负。根因不是缺某个字段，而是事件 interface 从未被当作状态同步 interface 设计。

## 决策

**D1 事件负载契约**：凡 SSE 事件必带两样——

1. **归属身份**：channelId 或对应聚合 id，消费端据此回答「这事件归谁」；
2. **就地更新所需的足量负载**：消费端据此回答「变了什么」，无需 REST 补拉。

新事件上线前过此检查；存量事件按此体检，不合格者排期补全。

**D2 演进方式一律 additive**：只加字段，不改现有字段语义。同一事件上挂着多个后端订阅者 + audit 落盘 + triggers，改形状 = 全部消费方同日切换，风险实打实、收益为零。

**D3 事件不回放**：SSE 断线期间的 missed events 不做序号/校验机制；消费端在重连时对受影响面做一次性 REST refetch 打底对齐（对齐「对账扫描」词条哲学：一次性投递 + best-effort 断链修复）。

## 存量事件体检验收（本批）

- `workunit.status_changed`：已合规（17 字段全量快照）——问题在消费侧不读负载，本批修消费侧。
- `workunit.execution.step` / `stream`：补 `channelId`（归属身份缺失）。
- `requirement.created` / `updated`：接入 SSE 桥（原只发进程内 eventBus），负载含 channelId/title/status。
- `workunit:tokens` → `workunit.tokens`：写 jsonl 处顺带发 SSE（原只落盘不推送）。

## 已知待体检事件（延期，各建工单）

- ~~`channel.message_updated`：负载带消息本体。~~ ✅ 已体检（#311 生产侧 commit 6deefd83 + #315 消费端迁移，2026-08）：两发射点 additive 挂 `message` 全量本体，消费端以 `message` 为准就地更新。
- ~~`agent.instance.status_changed`：负载带摘要。~~ ✅ 已体检（#312，2026-08-24）：负载 additive 带 `currentWorkUnit` 快照 + `channelId` + `lastError/lastErrorAt`，发布面扩到 error；roster/ChannelRail 就地消费，30s 轮询退位纯兜底。
- 前端共享 poll adapter（架构评审候选 8）：端点去重 + visibility 门禁 + SSE 健康联动。
