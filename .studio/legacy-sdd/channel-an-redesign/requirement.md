---
status: done
version: "1.0"
---

# 频道系统重构 — 需求规格

按 Agent Network 原则重构频道系统。去掉 broadcast/conversation 二分法和 @Analyst 硬编码触发，实现 @mention → WorkUnit 路由和 thread 回复反馈通道。

## 源项目清单

| # | 源项目 | 产出类型 | AC Group |
|---|--------|---------|----------|
| 1 | 删除 Channel.mode/agentName/sessionId | Schema 迁移 + 代码清理 | A |
| 2 | 删除 conversation-handler + analyst-trigger + 孤儿文件 | 代码删除 | A |
| 3 | @mention → WorkUnit 创建 | 新功能（后端） | B |
| 4 | Thread 回复自动关联 WorkUnit | 新功能（后端） | B |
| 5 | Thread 内 @mention = 反馈，不创建 WorkUnit | 路由逻辑 | B |
| 6 | Discord command-runner 适配 | 代码修改 | A |
| 7 | 前端 @mention autocomplete 改用 AgentProfile | 前端修改 | C |
| 8 | 前端 Thread 回复 UI | 前端新功能 | C |

## AC Group A：删除旧模式 + 清理

covers: [源项目 1, 2, 6]

### AC-A1：删除 Channel.mode / agentName / sessionId

- **触发**：Schema migration 执行
- **预期**：`Channel` model 无 `mode`、`agentName`、`sessionId` 三个字段
- **验证**：`prisma validate` 通过；`grep -r "channel\.mode\|channel\.agentName\|channel\.sessionId" apps/api/src/` 返回 0 结果
- **边界**：现有数据中三个字段值丢失（无迁移需要，直接 `prisma db push`）
- **不做**：不删除 ChannelMessage.agentName

### AC-A2：删除 conversation-handler 及其依赖

- **触发**：删除文件
- **预期**：以下文件删除后 `tsc --noEmit` 通过：
  - `channels/conversation-handler.ts`
  - `channels/conversation-converter.ts`
  - `channels/__tests__/conversation-handler.test.ts`
  - `channels/__tests__/conversation-handler-integration.test.ts`
  - `channels/__tests__/channel-conversation-schema.test.ts`
  - `channels/__tests__/conversation-converter.test.ts`
- **验证**：`ls` 确认文件不存在；`tsc --noEmit` 无引用错误
- **不做**：不删除 card action 逻辑（由 AC-A5 处理）

### AC-A3：删除 @Analyst 触发链

- **触发**：删除文件
- **预期**：以下文件删除后 `tsc --noEmit` 通过：
  - `channels/analyst-trigger.service.ts`
  - `channels/analyst-prompt.ts`
  - `channels/analyst-executor.ts`
  - `channels/analyst-prescan.ts`
  - `channels/analyst-scout.ts`
  - `channels/analyst-synthesizer.ts`
  - `channels/analyst-knowledge.ts`
  - `channels/analyst-fact-verification.ts`
  - `channels/contract-test-validator.ts`
  - `channels/contract-test-red-check.ts`
  - `channels/acgroup-tier.ts`
  - `channels/multi-repo-split.ts`
  - `channels/discovery-exposure.service.ts`
  - `channels/sdd-verification.ts`
- **验证**：`tsc --noEmit` 无引用错误
- **不做**：不删除 `requirements-doc.routes.ts`（独立路由）

### AC-A4：Discord command-runner 适配

- **触发**：`discord/command-runner.ts` 编译报错（import 已删除的 analyst-trigger）
- **预期**：Discord 命令改为创建 WorkUnit（调用 WorkUnitService.create），不再调用 analystTriggerService
- **验证**：`tsc --noEmit` 通过
- **边界**：Discord 消息内容作为 WorkUnit scope
- **不做**：不改 Discord 命令的其他逻辑

### AC-A5：清理 channel.routes.ts 旧路由

- **触发**：删除 conversation/analyst 分支后
- **预期**：
  - 删除 `POST /:id/convert` 路由（L591-611）
  - 删除整个 `POST /:channelId/messages/:messageId/actions` 路由（L397-588）— 全部 8 个 action 分支均为 Analyst/KK/Auditor 旧模式，删除后 route handler 变空壳，一并移除
  - 消息处理路由简化为：replyToId 检查 → @mention 检查 → 纯存储
- **验证**：`tsc --noEmit` 通过
- **不做**：不删除 CRUD 路由（GET/POST/DELETE channel）

## AC Group B：@mention 路由 + Thread 回复

covers: [源项目 3, 4, 5]

### AC-B1：@mention 检测 + WorkUnit 创建

- **触发**：`POST /channels/:id/messages`，content 包含 `@name`，且 replyToId 不存在
- **预期**：
  1. 提取 `@name`（正则 `/@([\w-]+)/`）
  2. 查询 AgentProfile（`WHERE name = extractedName AND status = 'active'`）
  3. 创建 WorkUnit：`scope = content.replace(/@[\w-]+\s*/, '')`，`channelId`，`type = 'task'`，`status = 'unassigned'`，`metadata = { mentionName, matched: boolean }`
  4. ChannelMessage 关联 `workUnitId`
  5. EventBus 自动发 `workunit.created`（WorkUnitService.create 内部）
- **验证**：单元测试 — 有匹配 Agent → WorkUnit 创建 + metadata.matched = true
- **边界**：@name 无匹配 → 仍创建 WorkUnit（metadata.matched = false）；多个 @ → 取第一个
- **不做**：不调 LLM 判断意图；不做 Agent 不存在时的用户提示（后续前端 autocomplete 解决）

### AC-B2：Thread 回复自动关联 WorkUnit

- **触发**：`POST /channels/:id/messages`，`replyToId` 存在
- **预期**：
  1. 查询被回复消息的 `workUnitId`
  2. 新消息继承同一 `workUnitId`
  3. 新消息的 `replyToId` = 原消息 id
- **验证**：单元测试 — 回复带 workUnitId 的消息 → 新消息 workUnitId 相同
- **边界**：被回复消息 `workUnitId = null` → 新消息 `workUnitId = null`（普通回复，非 WorkUnit 反馈）
- **不做**：不改 AgentLoop newReplies 逻辑（现有机制已支持）

### AC-B3：Thread 内 @mention 不创建新 WorkUnit

- **触发**：`POST /channels/:id/messages`，`replyToId` 存在 + content 包含 `@name`
- **预期**：`replyToId` 优先级高于 `@mention` — 不创建 WorkUnit，仅存消息（带 workUnitId 继承）
- **验证**：单元测试 — thread 内 @mention → 无新 WorkUnit 创建
- **边界**：无
- **不做**：不解析 @name

### AC-B4：消息处理路由分发（整合）

- **触发**：`POST /channels/:id/messages`
- **预期**：路由优先级：
  1. `replyToId` 存在 → thread 回复（AC-B2），忽略 @mention（AC-B3）
  2. `@name` 存在 → @mention 创建 WorkUnit（AC-B1）
  3. 其他 → 纯存储
- **验证**：集成测试覆盖三种路径
- **边界**：content 为空 → 400（现有逻辑不变）
- **不做**：不保留 conversation/@Analyst/@KK 分支

## AC Group C：前端适配

covers: [源项目 7, 8]

### AC-C1：@mention autocomplete 改用 AgentProfile

- **触发**：用户在频道输入框输入 `@`
- **预期**：
  1. 下拉列表从 API 获取活跃 AgentProfile（`GET /agent-profiles?status=active`）
  2. 展示 `name` + `description`
  3. 选中后插入 `@name` 到输入框
- **验证**：手动测试 — 输入 @ 看到动态 Agent 列表（非硬编码 7 个）
- **边界**：无活跃 Agent → 展示空列表或 "无可用 Agent" 提示
- **不做**：不做 Agent 创建 UI

### AC-C2：Thread 回复 UI

- **触发**：用户点击消息的"回复"按钮
- **预期**：
  1. `ChannelMessageItem` 新增"回复"按钮（hover 时显示）
  2. 点击后 `ChannelInput` 显示引用预览（被回复消息摘要 + 作者）
  3. 发送时 `sendMessage(content, replyToId)` 带 replyToId
  4. 点击"取消"退出回复模式
- **验证**：手动测试 — 回复消息 → 前端展示引用关系
- **边界**：被回复消息已被删除 → 显示 "已删除消息"
- **不做**：不做嵌套 thread（仅一层 reply）；不做 thread 侧边栏

### AC-C3：回复消息渲染

- **触发**：消息列表渲染，消息有 `replyToId`
- **预期**：
  1. `ChannelMessageItem` 显示引用块（被回复消息的作者 + 内容摘要）
  2. 点击引用块滚动到被回复消息（可选，后续做）
- **验证**：手动测试 — 有 replyToId 的消息显示引用预览
- **边界**：replyToId 指向的消息不在当前加载范围 → 引用块显示 "查看原消息"
- **不做**：不做嵌套引用渲染

## 不做项

- 不改 AgentLoop
- 不实现 Agent 主动参与频道讨论
- 不做消息→WorkUnit 自动检测（非 @mention 触发）
- 不改 WorkUnit 数据模型
- 不改 AgentProfile 数据模型
- 不做 Agent 创建/管理 UI
- 不做通知系统（@mention 无 Agent 时的提示）
