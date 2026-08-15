---
id: "an-phase2-mvp2-6"
slug: "agent-network-phase2-mps2-6"
title: "Agent Network Phase 2 — MVP-2~6"
status: "done"
tier: standard
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
tags: ["agent-network", "ui", "monitoring", "dogfood"]
createdAt: "2026-06-25T00:00:00Z"
updatedAt: "2026-06-25T00:00:00Z"
---

### MVP-2: AgentDashboard

**Implementation Notes**

新建 monitoring REST 模块。monitoring.service.ts 聚合 AgentProfile + RuntimeInstance 数据。monitoring.routes.ts 暴露 GET /agents 和 GET /stats（MVP-6 复用）。

前端新建 AgentDashboardPage.tsx，参考 GoalListPage 的卡片布局模式。新建 api/monitoring.ts 客户端。

**Architecture Context**

- Functions:
  - `MonitoringService.getAgentSummary(): Promise<AgentSummary>` @ monitoring.service.ts (新建)
  - `GET /api/v1/monitoring/agents` @ monitoring.routes.ts (新建)
- Call Chain: route → MonitoringService → prisma.agentProfile.findMany(include RuntimeInstance) → aggregate
- Imports: `prisma` from `@dommaker/studio-prisma`, `Router` from `express`
- Danger Zones: 不修改 AgentProfile/RuntimeInstance service，只读取
- Verified At: 新建 monitoring.service.test.ts

**Code Patterns**
参考 workunit.routes.ts 的路由注册模式（Router + service 注入）。
参考 GoalListPage 的 StatBadge + 卡片布局。

---

### MVP-3: Review UI

**Implementation Notes**

纯前端改动。WorkUnitListPage.tsx 已有通过/拒绝按钮，需增强拒绝流程：弹出 Modal 输入原因 → 调用 reviewRejected(id, reason)。

workunitApi.reviewRejected 需添加 reason 参数。workunitStore.reviewRejected 同步更新。

**Architecture Context**

- Functions:
  - `workunitApi.reviewRejected(id: string, reason?: string)` @ api/workunit.ts:70
  - `useWorkUnitStore.reviewRejected(id: string, reason?: string)` @ stores/workunitStore.ts:68
- Call Chain: button click → Modal → store.reviewRejected → API → reload list
- Imports: 无新依赖
- Danger Zones: 不修改后端 review-rejected 端点（已有 reason 支持）
- Verified At: 手动测试

**Code Patterns**
参考现有 reviewPassed/reviewRejected 的 store action 模式。

---

### MVP-4: Discussion Space

**Implementation Notes**

后端：新建 channel-message.events.ts，订阅 `channel.message.created` 事件，调用 channelMessageService 写入 DB。解决 AgentLoop.postToDiscussionSpace 空操作问题。

前端：新建 DiscussionPanel.tsx 组件，嵌入 WorkUnitListPage 的展开行。消息列表 + 发送表单。调用 GET/POST /workunits/:id/messages。

**Architecture Context**

- Functions:
  - `registerChannelMessageEvents()` @ channel-message.events.ts (新建) — EventBus subscriber
  - `DiscussionPanel({ workUnitId })` @ components/DiscussionPanel.tsx (新建)
  - `workunitApi.getMessages(id, params?)` @ api/workunit.ts (新增)
  - `workunitApi.postMessage(id, content, authorType?)` @ api/workunit.ts (新增)
- Call Chain (后端): EventBus publish → subscriber → channelMessageService.createAgentMessage/createHumanMessage → DB
- Call Chain (前端): DiscussionPanel → workunitApi.getMessages → render; submit → workunitApi.postMessage → refresh
- Imports: `eventBus` from `@dommaker/studio-shared`, `channelMessageService` from `../channels/channel-message.service.js`
- Danger Zones: 不修改 channelMessageService 本身，不修改 AgentLoop.postToDiscussionSpace
- channelId 解决策略：从 payload.workUnitId 查询 WorkUnit 获取 channelId；若 WorkUnit 无 channelId，fallback 查找 type='rnd' 的 Channel（与 workunit.routes.ts POST /:id/messages 逻辑一致）
- Verified At: 新建 channel-message.events.test.ts + 手动测试

**Code Patterns**
参考 trigger-scheduler.ts 的 EventBus subscribe 模式。
参考 ChannelDetailPage 的消息列表渲染模式。

---

### MVP-5: Agent 超时释放

**Implementation Notes**

1. Prisma migration：RuntimeInstance 添加 lastHeartbeat DateTime? 字段
2. AgentLoop.scanForWork() 开头更新 lastHeartbeat（`prisma.runtimeInstance.update`）
3. 新增 SCHEDULE trigger：每 2 分钟扫描 lastHeartbeat 超过 5 分钟的 idle/active 实例 → terminated + unclaim WorkUnit
4. AgentInstanceService 添加 terminate(id) 方法：标记 terminated + unclaim currentWorkUnit
5. AgentInstance routes 添加 POST /:id/terminate 端点
6. AgentDashboardPage 添加"强制释放"按钮

**Architecture Context**

- Functions:
  - `AgentInstanceService.terminate(id: string): Promise<RuntimeInstance>` @ agent-instance.service.ts (新增)
  - `POST /agent-instances/:id/terminate` @ agent-instance.routes.ts (新增)
  - `AgentLoop.scanForWork()` @ agent-loop.ts:116 — 添加 heartbeat 更新
  - `agent-timeout` trigger @ default-triggers.ts (新增)
- Call Chain (terminate): HTTP → service.terminate → prisma.update(terminated) + workUnitService.unclaim(currentWorkUnitId)
- Call Chain (auto-release): trigger tick → scan lastHeartbeat < threshold → terminate
- Imports: `WorkUnitService` from `../workunit/workunit.service.js`
- Danger Zones:
  - agent-loop.ts tryClaim 不修改（只改 scanForWork 开头）
  - 状态机不修改（terminated 是 RuntimeInstance 状态，非 WorkUnit 状态）
- Verified At: 新建 agent-instance.service.test.ts terminate 用例 + agent-loop.test.ts heartbeat 用例

**Code Patterns**
参考 workunit-timeout trigger 的 SCHEDULE 模式。
参考 AgentLoop.stop() 的 terminated 标记逻辑。

---

### MVP-6: Monitoring Dashboard

**Implementation Notes**

复用 MVP-2 的 monitoring 模块。MonitoringService 添加 getStats() 方法，聚合 WorkUnit + RuntimeInstance 统计。

MonitoringPage.tsx 参考 GoalListPage 的 StatBadge 布局。

**Architecture Context**

- Functions:
  - `MonitoringService.getStats(): Promise<MonitoringStats>` @ monitoring.service.ts (扩展)
  - `GET /api/v1/monitoring/stats` @ monitoring.routes.ts (扩展)
  - `MonitoringPage()` @ pages/MonitoringPage.tsx (新建)
- Call Chain: route → service.getStats → prisma.workUnit.groupBy(status) + prisma.runtimeInstance.groupBy(status) + prisma.workUnit.count(completedLast24h)
- Imports: `prisma` from `@dommaker/studio-prisma`
- Danger Zones: 不修改已有的 getAgentSummary 方法
- Verified At: 扩展 monitoring.service.test.ts

**Code Patterns**
参考 MVP-2 的 getAgentSummary 聚合模式。
