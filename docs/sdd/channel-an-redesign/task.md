---
status: done
version: "1.0"
---

# 频道系统重构 — 任务文档

## 契约测试规划

### AC-A1：Schema 删除

| 测试文件 | 测试用例 |
|---------|---------|
| `channels/__tests__/schema-cleanup.test.ts`（新建）| Channel create 不设 mode/agentName/sessionId → 成功 |
| 同上 | Channel create 后 `channel.mode` 为 undefined |

### AC-A2：删除 conversation-handler

| 测试文件 | 测试用例 |
|---------|---------|
| 无新测试 | 删除文件后 `tsc --noEmit` 通过即验证 |
| 同上 | 删除文件后 `ls` 确认不存在 |

### AC-A3：删除 @Analyst 触发链

| 测试文件 | 测试用例 |
|---------|---------|
| 无新测试 | 删除文件后 `tsc --noEmit` 通过即验证 |

### AC-A4：Discord command-runner 适配

| 测试文件 | 测试用例 |
|---------|---------|
| `discord/__tests__/command-runner.test.ts`（修改现有）| Discord 命令 → WorkUnit 创建（验证 WorkUnitService.create 被调用） |
| 同上 | WorkUnit scope = 用户消息内容 |
| 同上 | WorkUnit channelId = rnd channel id |

### AC-A5：清理 channel.routes.ts 旧路由

| 测试文件 | 测试用例 |
|---------|---------|
| `channels/__tests__/route-cleanup.test.ts`（新建）| `POST /:id/convert` 返回 404 |
| 同上 | 消息发送不再有 `analystTriggered` 字段 |

### AC-B1：@mention 创建 WorkUnit

| 测试文件 | 测试用例 |
|---------|---------|
| `channels/__tests__/mention-workunit.test.ts`（新建）| @mention + 匹配 Agent → WorkUnit 创建 + metadata.matched=true |
| 同上 | @mention + 不匹配 → WorkUnit 创建 + metadata.matched=false |
| 同上 | scope 去掉 @name 前缀 |
| 同上 | ChannelMessage.workUnitId 关联正确 |
| 同上 | EventBus 发 workunit.created 事件 |
| 同上 | 多个 @ → 取第一个 |

### AC-B2：Thread 回复关联 WorkUnit

| 测试文件 | 测试用例 |
|---------|---------|
| `channels/__tests__/thread-reply.test.ts`（新建）| 回复有 workUnitId 的消息 → 新消息继承 workUnitId |
| 同上 | 回复无 workUnitId 的消息 → 新消息 workUnitId=null |
| 同上 | replyToId 指向不存在的消息 → 400 或 workUnitId=null |

### AC-B3：Thread 内 @mention = 反馈

| 测试文件 | 测试用例 |
|---------|---------|
| `channels/__tests__/thread-mention.test.ts`（新建）| replyToId + @mention → 不创建 WorkUnit |
| 同上 | 消息正常存储（带 workUnitId 继承 + replyToId） |

### AC-B4：消息路由分发

| 测试文件 | 测试用例 |
|---------|---------|
| `channels/__tests__/message-routing.test.ts`（新建）| 纯文本 → 无 WorkUnit |
| 同上 | @mention（无 replyToId）→ WorkUnit |
| 同上 | replyToId（无 @mention）→ 无 WorkUnit，继承 workUnitId |
| 同上 | replyToId + @mention → 无 WorkUnit（replyToId 优先） |

### AC-C1：@mention autocomplete

| 测试文件 | 测试用例 |
|---------|---------|
| 前端手动测试 | 输入 @ → 展示 AgentProfile 列表（动态，非硬编码） |
| 同上 | 无活跃 Agent → 空列表或提示 |
| 同上 | 选中后插入 @name 到输入框 |

### AC-C2：Thread 回复 UI

| 测试文件 | 测试用例 |
|---------|---------|
| 前端手动测试 | 点击"回复" → 输入框显示引用预览 |
| 同上 | 发送 → API 调用带 replyToId |
| 同上 | 取消 → 退出回复模式 |

### AC-C3：回复消息渲染

| 测试文件 | 测试用例 |
|---------|---------|
| 前端手动测试 | 有 replyToId 的消息 → 显示引用块 |
| 同上 | 引用块显示被回复消息的作者 + 内容摘要 |

## 执行顺序

### Phase 1：后端重构

```
Step 1a: schema.prisma 删除 mode/agentName/sessionId
  → prisma db push
  → checkpoint: prisma validate 通过

Step 1b: 删除 32 个文件（15 源文件 + 17 测试）
  → conversation-handler + 依赖 + 测试（5 文件）
  → analyst-trigger + 依赖 + 测试（27 文件）
  → 附带清理 knowledge-sync.service.ts 字符串引用
  → checkpoint: ls 确认文件不存在

Step 1c: channel.routes.ts 重写
  → 删除旧路由分支
  → 新增 @mention 检测 + WorkUnit 创建
  → 新增 replyToId 处理
  → checkpoint: tsc --noEmit 通过

Step 1d: discord/command-runner.ts 修改
  → 替换 analystTriggerService → WorkUnitService
  → checkpoint: tsc --noEmit 通过

Step 1e: 后端测试
  → 编写 mention-workunit / thread-reply / thread-mention / message-routing 测试
  → 修改 discord command-runner 测试
  → checkpoint: npm test 通过
```

### Phase 2：前端适配

```
Step 2a: ChannelInput.tsx
  → 回复模式（replyTo prop + 引用预览 UI）
  → Agent autocomplete 改 API 获取
  → checkpoint: 手动测试输入 @ + 回复

Step 2b: ChannelMessageItem.tsx
  → 回复按钮（hover 显示）
  → 引用渲染（replyToId 存在时）
  → checkpoint: 手动测试回复按钮 + 引用显示

Step 2c: ChannelDetailPage.tsx
  → 回复状态管理（replyTo state）
  → handleSend 传递 replyToId
  → checkpoint: 端到端测试发消息→回复→显示
```

### Phase 3：验证 + 部署

```
Step 3a: tsc --noEmit
Step 3b: npm test（全量）
Step 3c: 线上部署
  → API: systemctl restart studio-api
  → 前端: vite build → deploy
  → checkpoint: 线上功能验证
```

## 里程碑

| 里程碑 | 完成标准 | 预计 |
|--------|---------|------|
| M1: Schema + 文件清理 | Step 1a-1b 完成，tsc 通过 | Phase 1 前半 |
| M2: 后端路由重写 | Step 1c-1e 完成，全测试通过 | Phase 1 后半 |
| M3: 前端适配 | Step 2a-2c 完成，手动测试通过 | Phase 2 |
| M4: 线上部署 | Step 3a-3c 完成 | Phase 3 |
