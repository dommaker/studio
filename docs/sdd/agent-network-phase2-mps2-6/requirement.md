---
id: "an-phase2-mvp2-6"
slug: "agent-network-phase2-mps2-6"
title: "Agent Network Phase 2 — MVP-2~6"
status: implemented
tier: standard
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
tags: ["agent-network", "ui", "monitoring", "dogfood"]
createdAt: "2026-06-25T00:00:00Z"
updatedAt: "2026-06-25T00:00:00Z"
---

## 一句话总结

补齐 Agent Network Phase 2 剩余 5 个 MVP：AgentDashboard、Review UI、Discussion Space、超时释放、监控看板。

## 背景

MVP-1（WorkUnit 页面）已完成。后端 API 大部分已存在，需补齐：聚合统计端点、EventBus subscriber、RuntimeInstance 超时机制。前端需新建 3 个页面 + 增强 1 个页面。

## AC Groups

### MVP-2: AgentDashboard

#### 验收标准
- [ ] GET /api/v1/monitoring/agents 返回 agent 列表含 id/name/status/currentWorkUnitId/startedAt
- [ ] 响应含 summary 字段：{ total, idle, active, terminated }
- [ ] AgentDashboardPage 展示所有 Agent 状态卡片（名称、状态、当前 WorkUnit、运行时长）
- [ ] 状态统计 badge 数字与 API summary 一致
- [ ] 路由 /agents 可访问，侧边栏有导航入口

#### 涉及文件
- apps/api/src/modules/monitoring/monitoring.routes.ts (新建)
- apps/api/src/modules/monitoring/monitoring.service.ts (新建)
- apps/web/src/api/monitoring.ts (新建)
- apps/web/src/pages/AgentDashboardPage.tsx (新建)
- apps/web/src/App.tsx (路由)
- apps/web/src/components/SidebarNew.tsx (导航)

#### 依赖: 无

---

### MVP-3: Review UI

#### 验收标准
- [ ] in_review 状态的 WorkUnit 显示通过/拒绝按钮
- [ ] 点击拒绝弹出原因输入框，可输入原因后确认
- [ ] 审查通过后 WorkUnit 状态变为 done
- [ ] 连续 3 次拒绝后 WorkUnit 状态变为 blocked
- [ ] 拒绝原因通过 POST /workunits/:id/review-rejected 的 reason 字段传递

#### 涉及文件
- apps/web/src/pages/WorkUnitListPage.tsx (增强)
- apps/web/src/api/workunit.ts (reviewRejected 添加 reason 参数)
- apps/web/src/stores/workunitStore.ts (reviewRejected 添加 reason 参数)

#### 依赖: 无

---

### MVP-4: Discussion Space

#### 验收标准
- [ ] EventBus channel.message.created 事件触发消息写入 ChannelMessage 表
- [ ] GET /workunits/:id/messages 返回该 WorkUnit 的讨论消息列表
- [ ] WorkUnit 展开行内显示讨论消息列表（agent 输出 + 人工评论）
- [ ] 人工可在讨论区发消息（POST /workunits/:id/messages）
- [ ] Agent 输出标记为 authorType=agent，人工标记为 authorType=human

#### 涉及文件
- apps/api/src/modules/channels/channel-message.events.ts (新建，EventBus subscriber)
- apps/web/src/components/DiscussionPanel.tsx (新建)
- apps/web/src/api/workunit.ts (添加 getMessages/postMessage)
- apps/web/src/pages/WorkUnitListPage.tsx (集成 DiscussionPanel)

#### 依赖: 无

---

### MVP-5: Agent 超时释放

#### 验收标准
- [ ] RuntimeInstance 表新增 lastHeartbeat 字段（Prisma migration）
- [ ] AgentLoop 每次 scanForWork 时更新 lastHeartbeat 为当前时间
- [ ] 超时扫描 trigger 每 2 分钟执行，将超时实例标记 terminated 并 unclaim 其 WorkUnit
- [ ] POST /agent-instances/:id/terminate 端点强制 terminated + unclaim WorkUnit
- [ ] AgentDashboard 显示"强制释放"按钮，点击触发 terminate API

#### 涉及文件
- packages/studio-prisma/prisma/schema.prisma (lastHeartbeat 字段)
- packages/studio-prisma/prisma/migrations/ (migration)
- apps/api/src/modules/agents/agent-loop.ts (heartbeat 更新)
- apps/api/src/modules/agents/agent-instance.service.ts (terminate 方法)
- apps/api/src/modules/agents/agent-instance.routes.ts (terminate 端点)
- apps/api/src/modules/agents/default-triggers.ts (超时扫描 trigger)
- apps/web/src/pages/AgentDashboardPage.tsx (强制释放按钮)

#### 依赖: MVP-2（AgentDashboard 页面需先存在）

---

### MVP-6: Monitoring Dashboard

#### 验收标准
- [ ] GET /api/v1/monitoring/stats 返回 WorkUnit 按 status 聚合数据
- [ ] 响应含 agents 字段：{ total, idle, active, terminated }
- [ ] 响应含 recent 字段：{ completedLast24h, failedLast24h }
- [ ] MonitoringPage 展示 WorkUnit 状态分布
- [ ] Agent 利用率显示（active / total）
- [ ] 最近 24h 完成/失败数可见
- [ ] 路由 /monitoring 可访问，侧边栏有导航入口

#### 涉及文件
- apps/api/src/modules/monitoring/monitoring.routes.ts (扩展)
- apps/api/src/modules/monitoring/monitoring.service.ts (扩展)
- apps/web/src/api/monitoring.ts (扩展)
- apps/web/src/pages/MonitoringPage.tsx (新建)
- apps/web/src/App.tsx (路由)
- apps/web/src/components/SidebarNew.tsx (导航)

#### 依赖: MVP-2（共享 monitoring 模块）

## 非目标

- Agent 编辑/删除（RolesPage 已有）
- 审查历史 timeline（后续迭代）
- 消息实时推送（SSE/WebSocket）— 用轮询/手动刷新
- 心跳协议（WebSocket ping/pong）— 用 scan 间隔更新
- 实时监控刷新（SSE）— 手动刷新
