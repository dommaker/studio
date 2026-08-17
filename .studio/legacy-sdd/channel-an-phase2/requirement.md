---
status: done
version: "1.0"
source: docs/sdd/channel-an-redesign/analysis-agent-network-channel.md
gaps: [1, 2, 3, 5, 6, 16, 17, 20, 21]
---

# Channel × Agent Network Phase 2 — 需求规格

基于 Phase 1 完成后的深度分析（analysis-agent-network-channel.md），实现 Channel 系统的 Agent Network 集成：@mention 绑定 assigneeId、Channel 成员管理、Thread 隔离、Convert to Task、项目发现与绑定。

## 依赖与约束

### 前置依赖

- Phase 1（channel-an-redesign）已完成：消息路由重写 + 前端 @mention autocomplete + thread 回复 UI
- 分析文档（analysis-agent-network-channel.md）中所有设计决策已收敛

### 组间依赖

- AC Group E（Convert to Task）依赖 AC Group D（项目发现）和 AC Group C（Thread 锚点机制）
- AC Group B（成员管理）的 AC-B4 依赖 AC Group A 的 AC-A2（listAgents 过滤）
- AC Group C 的 AC-C3（前端 Thread 渲染）依赖 AC-C1 + AC-C2（后端 Thread 数据）

### 约束

- 现有 `Project` 模型是 PMO 模型（pmoNumber + companyId required），不适合本地项目发现 → 采用 `projectPath` 直接存储方案
- `postToDiscussionSpace()` 绕过 `ChannelMessageService`（SSE 缺失）是已知问题，本 Phase 不重构
- SQLite JSON 字段过滤能力有限 → 应用层过滤

## 源项目清单

| # | 源项目 | 产出类型 | AC Group | 分析缺口 |
|---|--------|---------|----------|---------|
| 1 | @mention → assigneeId 绑定 | 后端修改 | A | #1 |
| 2 | listAgents 过滤在线状态 | 后端修改 | A | #2 |
| 3 | Channel 成员管理（members 字段 + API） | Schema + 后端 + 前端 | B | #3 |
| 4 | Thread-per-WorkUnit | 后端逻辑 | C | #20 |
| 5 | Agent 消息写入 Thread | 后端修改 | C | #21 |
| 6 | 项目发现（扫描本地目录） | 新模块 | D | #16 |
| 7 | WorkUnit 关联 Project | Schema + 后端 | D | #17 |
| 8 | Convert to Task API + 前端 | API + 前端 + LLM | E | #5 |

## AC Group A：路由改进

covers: [源项目 1, 2]

### AC-A1：@mention 绑定 assigneeId

- **触发**：`POST /channels/:id/messages`，content 包含 `@name`，replyToId 不存在
- **预期**：
  1. `detectMention()` 提取 `@name`
  2. 查询 AgentProfile（`WHERE name = extractedName AND status = 'active'`）
  3. 创建 WorkUnit 时设置 `assigneeId = agent.id`（匹配成功时）
  4. 无匹配 Agent → `assigneeId = null`（保持当前行为，由 AgentLoop claim）
  5. `metadata.matched = true/false` 记录匹配状态
- **验证**：单元测试 — 有匹配 → assigneeId 非空；无匹配 → assigneeId = null
- **边界**：Agent 在线但繁忙（有 active WorkUnit）→ 仍然 assigneeId 绑定（超时释放由已有机制处理）
- **不做**：不实现 Agent 繁忙时的排队/通知

### AC-A2：listAgents 过滤在线状态

- **触发**：`GET /agent-profiles?status=active`
- **预期**：
  1. 返回的 AgentProfile 列表中包含在线状态字段
  2. 在线状态 = 该 Agent 是否有 active 状态的 RuntimeInstance
  3. 前端 @mention autocomplete 传入 channelId 参数，后端按 Channel members 过滤返回
- **验证**：单元测试 — RuntimeInstance 存在且 active → 在线；无 RuntimeInstance → 离线
- **边界**：RuntimeInstance stale（进程已死但记录未清理）→ 后续通过心跳解决，本阶段不过滤
- **不做**：不实现心跳机制

## AC Group B：Channel 成员管理

covers: [源项目 3]

### AC-B1：Channel.members 字段

- **触发**：Schema migration
- **预期**：
  1. `Channel` model 新增 `members` 字段（String，JSON 数组，存 AgentProfile ID 列表）
  2. 默认值 `[]`（空数组 = 所有人可见，兼容当前行为）
  3. `agent-profile.service.list()` 支持 `channelId` 过滤参数 → 只返回在该 Channel members 中的 Agent
- **验证**：`prisma validate` 通过；单元测试 — 创建 Channel 带 members → listAgents(channelId) 只返回对应 Agent
- **边界**：members 为空数组 → 返回所有 active Agent（兼容兜底）
- **不做**：不删除 AgentProfile.channels 字段（后续清理）

### AC-B2：Channel 成员管理 API

- **触发**：`PATCH /channels/:id/members`
- **预期**：
  1. 请求体 `{ add: [agentId1], remove: [agentId2] }`
  2. 更新 Channel.members 数组
  3. 返回更新后的 members 列表
- **验证**：API 测试 — add agent → members 包含该 agent；remove → 移除
- **边界**：add 已存在的 agent → 幂等（不重复）；remove 不存在的 agent → 幂等
- **不做**：不验证 agentId 是否有效（由前端保证）

### AC-B3：Channel 创建时指定成员

- **触发**：`POST /channels`（创建 Channel）
- **预期**：
  1. 请求体支持 `members: [agentId1, agentId2]` 字段
  2. 创建时写入 Channel.members
- **验证**：API 测试 — 创建带 members 的 Channel → 查询 members 正确
- **边界**：不传 members → 默认 `[]`
- **不做**：不实现前端 Channel 创建 UI 改造（后续）

### AC-B4：前端 @mention autocomplete 按 Channel 过滤

- **触发**：用户在 Channel 输入 `@`
- **预期**：
  1. 调用 `GET /agent-profiles?status=active&channelId=<当前ChannelId>`
  2. 只返回该 Channel 的 members
  3. 若 members 为空 → 回退返回所有 active Agent（兼容）
- **验证**：手动测试 — 不同 Channel 输入 @ 看到不同 Agent 列表
- **边界**：Channel 无 members → 显示所有 Agent
- **不做**：不显示在线/离线状态标记（AC-A2 后续）

## AC Group C：Thread 隔离

covers: [源项目 4, 5]

### AC-C1：Thread-per-WorkUnit（锚点消息）

- **触发**：WorkUnit 创建时（@mention 触发 或 Convert to Task 触发）
- **预期**：
  1. 创建 WorkUnit 时的原始 ChannelMessage 成为 Thread 锚点
  2. 该消息的 `workUnitId` 已设置（现有行为）
  3. 后续该 WorkUnit 相关的所有消息都带 `replyToId` 指向锚点消息
  4. 前端 Thread 渲染：锚点消息 + 回复消息列表
- **验证**：单元测试 — WorkUnit 创建后，回复该消息 → 回复消息 replyToId = 锚点消息 id
- **边界**：锚点消息被删除 → Thread 内消息仍可渲染（replyToId 弱引用）
- **不做**：不实现 Thread 侧边栏（主时间线内联显示）

### AC-C2：Agent 消息写入 Thread

- **触发**：AgentLoop 执行 WorkUnit 后产出结果
- **预期**：
  1. `postToDiscussionSpace()` 查询 WorkUnit 关联的锚点消息（该 WorkUnit 的第一条消息）
  2. 设置 `replyToId = 锚点消息.id`
  3. Agent 进度消息、结果消息都在 Thread 内
- **验证**：单元测试 — Agent 产出结果 → 消息 replyToId 非空，指向 WorkUnit 锚点
- **边界**：WorkUnit 无锚点消息（不应发生）→ 降级为无 replyToId
- **不做**：不区分进度消息和结果消息（都是 Thread 内消息）

### AC-C3：Thread 视图渲染

- **触发**：Channel 消息列表渲染
- **预期**：
  1. 锚点消息（有 workUnitId 且无 replyToId）显示为 Thread 头部
  2. Thread 内消息（有 replyToId 指向锚点）缩进显示在锚点消息下方，默认折叠
  3. Thread 头部显示回复数量 badge
  4. 点击 Thread 头部展开/折叠回复消息列表
- **验证**：手动测试 — WorkUnit 消息显示为 Thread，回复折叠在下方
- **边界**：非 Thread 消息正常显示（不受影响）
- **不做**：不做 Thread 独立页面

## AC Group D：项目发现与绑定

covers: [源项目 6, 7]

### AC-D1：项目发现（扫描本地目录）

- **触发**：Studio 本地服务启动时 或 `GET /projects` API 调用
- **预期**：
  1. 扫描配置的根目录（默认 `~/projects/` 或环境变量 `STUDIO_PROJECTS_ROOT`）
  2. 检测项目标志：`CLAUDE.md` 或 `package.json` 或 `.git/`
  3. 返回项目列表：`{ name, path, hasClaudeMd, language? }`
  4. 结果缓存（文件变更时刷新）
- **验证**：单元测试 — mock 目录结构 → 正确检测项目；API 测试 — GET /projects 返回列表
- **边界**：根目录不存在 → 返回空列表；嵌套项目（monorepo）→ 只检测顶层 + 一级子目录
- **不做**：不做文件监听（watch）自动刷新

### AC-D2：WorkUnit 关联 Project

- **触发**：Schema migration
- **预期**：
  1. `WorkUnit` model 新增 `projectPath` 字段（String?，可选）— 直接存本地项目路径
  2. WorkUnit 创建时支持传入 `projectPath`
  3. AgentLoop 执行 WorkUnit 时，取 `projectPath` 作为 cwd
- **验证**：单元测试 — WorkUnit 带 projectPath → 查询时包含 projectPath
- **设计决策**：用 `projectPath`（直接路径）而非 `projectId`（外键），因现有 Project 模型是 PMO 模型不适合本地发现。详见 design.md D1
- **边界**：projectPath 为空 → 使用默认路径（Channel.defaultPath 或 process.cwd）
- **不做**：不改 AgentLoop 的完整执行流程（只加 cwd 解析）

### AC-D3：项目发现 API

- **触发**：`GET /projects`
- **预期**：
  1. 调用项目发现服务（AC-D1）
  2. 返回项目列表：`{ data: [{ id, name, path, hasClaudeMd }] }`
  3. 支持 `?search=xxx` 参数模糊搜索
- **验证**：API 测试 — 返回本地项目列表
- **边界**：无项目 → 返回空数组
- **不做**：不实现项目 CRUD（项目是本地扫描的，不是数据库管理的）

## AC Group E：Convert to Task

covers: [源项目 8]

依赖：AC-D1（项目发现）、AC-D2（WorkUnit-Project 关联）

### AC-E1：Convert to Task API

- **触发**：`POST /channels/:id/messages/:messageId/convert-to-task`
- **预期**：
  1. 查询原始消息内容
  2. （可选）调 LLM 预填：从消息内容提取标题/描述/建议 assignee
  3. 创建 WorkUnit：`scope`、`channelId`、`assigneeId`（人确认的值）、`projectPath`（人选择的值）
  4. 原始消息更新 `workUnitId` → 新 WorkUnit.id（成为 Thread 锚点）
  5. 返回创建的 WorkUnit
- **验证**：API 测试 — 消息 convert → WorkUnit 创建 + 消息关联 workUnitId
- **边界**：消息已有 workUnitId → 400（不能重复转换）；消息不存在 → 404
- **不做**：不做 LLM 自动创建（必须人确认）

### AC-E2：LLM 预填建议

- **触发**：`POST /channels/:id/messages/:messageId/convert-to-task/suggest`
- **预期**：
  1. 接收消息内容 + 可用 Agent 列表 + 可用项目列表
  2. 调 LLM 分析消息内容
  3. 返回建议：`{ title, description, suggestedAssigneeId?, suggestedProjectPath? }`
  4. LLM 不决定，只建议 → 人确认后调 AC-E1
- **验证**：API 测试 — 返回 LLM 建议；单元测试 — 消息为空 → 返回空建议
- **边界**：LLM 调用失败 → 返回空建议（不阻断）；超时 5s → 返回空建议
- **不做**：不让 LLM 直接创建 WorkUnit

### AC-E3：前端 Convert to Task UI

- **触发**：用户 hover 消息 → 点击「转为任务」按钮
- **预期**：
  1. 消息 hover 显示操作按钮（回复 + 转为任务）
  2. 点击「转为任务」→ 弹出对话框
  3. 对话框自动调 AC-E2 获取 LLM 建议，预填表单
  4. 表单字段：标题、描述、分配给（下拉）、项目（下拉，来自 GET /projects）
  5. 确认 → 调 AC-E1 → 消息变为 Thread 锚点 → UI 刷新
- **验证**：手动测试 — hover → 点击 → 对话框 → 确认 → Thread 创建
- **边界**：已有 workUnitId 的消息 → 不显示「转为任务」按钮
- **不做**：不做批量转换

## 不做项

- 不迁移 SQLite → JSONL（Phase 3+ 独立 spec）
- 不实现 DATA 标签规范（Phase 3）
- 不实现 Skill 执行记录（Phase 3）
- 不实现知识引擎扩展（Phase 4）
- 不实现 git worktree 隔离（Phase 5）
- 不实现 Agent 读 Channel 历史（后续）
- 不实现 Agent 心跳/健康检查（后续）
- 不改 AgentProfile 数据模型（保持最小设计）
- 不实现多用户 Channel 同步
