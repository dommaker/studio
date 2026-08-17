---
status: done
version: "1.0"
---

# Channel × Agent Network Phase 2 — 设计文档

## 设计决策

### D1：项目绑定 — projectPath 而非 projectId

**决策**：WorkUnit 新增 `projectPath`（String?），不新建 LocalProject 表。

**理由**：
- 现有 `Project` 模型是 PMO 模型（`pmoNumber` + `companyId` required），不适合本地目录发现
- 需求明确："项目是本地扫描的，不是数据库管理的"
- AgentLoop 执行时只需要 path（cwd），不需要查询项目元数据
- 省去 schema migration 新建表 + 关系管理

**代价**：同项目的多个 WorkUnit 有 path 重复。可接受（单用户级别数据量）。

### D2：postToDiscussionSpace — 最小改动

**决策**：保持直接 `prisma.channelMessage.create` 模式，仅添加 anchor message 查找逻辑设置 replyToId。

**不做**：不重构为通过 `ChannelMessageService` 创建（SSE 缺失是已知问题，Phase 3+ 处理）。

**理由**：外科手术式修改。SSE 缺失影响所有 agent 消息实时推送，但不在本 Phase 范围。

### D3：Channel.members — JSON String 字段

**决策**：与 `AgentProfile.channels` 一致，用 JSON String 存 AgentProfile ID 数组。

**理由**：保持项目一致性。无 Prisma FK 关系（与现有裸字段模式一致）。

---

## 文件映射

### AC Group A：路由改进

| AC | 文件 | 改动类型 |
|----|------|---------|
| AC-A1 | `apps/api/src/modules/channels/message-routing.ts` | modify |
| AC-A1 | `apps/api/src/modules/channels/__tests__/message-routing.test.ts` | modify |
| AC-A2 | `apps/api/src/modules/agents/agent-profile.service.ts` | modify |
| AC-A2 | `apps/api/src/modules/agents/agent-profile.routes.ts` | modify |
| AC-A2 | `apps/api/src/modules/agents/__tests__/agent-profile.service.test.ts` | modify |
| AC-A2 | `apps/web/src/components/channel/ChannelInput.tsx` | modify |

### AC Group B：Channel 成员管理

| AC | 文件 | 改动类型 |
|----|------|---------|
| AC-B1 | `packages/studio-prisma/prisma/schema.prisma` | modify |
| AC-B1 | `packages/studio-prisma/prisma/migrations/` | new (migration) |
| AC-B2 | `apps/api/src/modules/channels/channel.routes.ts` | modify |
| AC-B2 | `apps/api/src/modules/channels/__tests__/channel-members.test.ts` | new |
| AC-B3 | `apps/api/src/modules/channels/channel.routes.ts` | modify |
| AC-B4 | `apps/web/src/api/channel.ts` | modify |
| AC-B4 | `apps/web/src/components/channel/ChannelInput.tsx` | modify |

### AC Group C：Thread 隔离

| AC | 文件 | 改动类型 |
|----|------|---------|
| AC-C1 | 无独立改动（锚点 = WU 创建时的原始消息，已由 message-routing 设置 workUnitId） | — |
| AC-C2 | `apps/api/src/modules/agents/agent-loop.ts` | modify |
| AC-C2 | `apps/api/src/modules/agents/__tests__/agent-loop-v2.test.ts` | modify |
| AC-C3 | `apps/web/src/pages/ChannelDetailPage.tsx` | modify |
| AC-C3 | `apps/web/src/components/channel/ChannelMessageItem.tsx` | modify |

### AC Group D：项目发现与绑定

| AC | 文件 | 改动类型 |
|----|------|---------|
| AC-D1 | `apps/api/src/modules/projects/project-discovery.service.ts` | new |
| AC-D1 | `apps/api/src/modules/projects/__tests__/project-discovery.test.ts` | new |
| AC-D2 | `packages/studio-prisma/prisma/schema.prisma` | modify |
| AC-D2 | `packages/studio-prisma/prisma/migrations/` | new (migration) |
| AC-D2 | `apps/api/src/modules/workunit/workunit.service.ts` | modify |
| AC-D3 | `apps/api/src/modules/projects/project.routes.ts` | new |
| AC-D3 | `apps/api/src/modules/projects/__tests__/project-discovery.test.ts` | new (extend) |

### AC Group E：Convert to Task

| AC | 文件 | 改动类型 |
|----|------|---------|
| AC-E1 | `apps/api/src/modules/channels/channel.routes.ts` | modify |
| AC-E1 | `apps/api/src/modules/channels/__tests__/convert-to-task.test.ts` | new |
| AC-E2 | `apps/api/src/modules/channels/convert-to-task.service.ts` | new |
| AC-E2 | `apps/api/src/modules/channels/__tests__/convert-to-task.test.ts` | new (extend) |
| AC-E3 | `apps/web/src/components/channel/ConvertToTaskDialog.tsx` | new |
| AC-E3 | `apps/web/src/components/channel/ChannelMessageItem.tsx` | modify |
| AC-E3 | `apps/web/src/api/channel.ts` | modify |

---

## 接口定义

### AC-A1：detectMention + routeMessage 改动

```typescript
// message-routing.ts — routeMessage 内 P2 分支改动

// 现有：
const workUnit = await workUnitService.create({
  scope,
  channelId,
  type: 'task',
  status: 'unassigned',
  metadata: { mentionName, matched: !!agent, creationMode: 'mention' },
});

// 改为：
const workUnit = await workUnitService.create({
  scope,
  channelId,
  type: 'task',
  status: 'unassigned',
  assigneeId: agent?.id ?? null,  // ← 新增
  metadata: { mentionName, matched: !!agent, creationMode: 'mention' },
});
```

`detectMention()` 不变。`agent` 查询不变（`WHERE name = mentionName AND status = 'active'`）。

### AC-A2：listAgents 在线状态 + channelId 过滤

```typescript
// agent-profile.service.ts

async list(options?: {
  status?: string;
  channelId?: string;   // 新增
  page?: number;
  limit?: number;
}): Promise<{ data: Array<AgentProfile & { isOnline: boolean }>; total: number }>

// 实现逻辑：
// 1. where 条件加 channelId 过滤：
//    channelId 有值时 → channels JSON 包含该 channelId
//    SQLite JSON 过滤：WHERE json_extract(channels, '$') LIKE '%"channelId"%'
//    或应用层过滤（JSON 字段在 SQLite 中不好做 SQL 过滤）
// 2. 查询每个 AgentProfile 对应的 RuntimeInstance：
//    SELECT roleId FROM runtime_instance WHERE status = 'active' AND roleId IN (...)
// 3. 结果中附加 isOnline 字段
```

```typescript
// agent-profile.routes.ts — GET / 改动

router.get('/', async (req, res) => {
  const { status, channelId } = req.query;  // 新增 channelId
  // ...
  const result = await service.list({
    status: status as string,
    channelId: channelId as string,  // 新增
    page,
    limit,
  });
  // 响应新增 isOnline 字段
});
```

### AC-B1：Channel.members 字段

```prisma
// schema.prisma — Channel model 新增

model Channel {
  // ... 现有字段 ...
  members String @default("[]")  // JSON: AgentProfile ID[]
}
```

### AC-B2：Channel 成员管理 API

```typescript
// channel.routes.ts — 新增端点

// PATCH /api/v1/channels/:id/members
router.patch('/:id/members', async (req, res) => {
  const { id } = req.params;
  const { add, remove } = req.body;
  // add: string[] (AgentProfile IDs to add)
  // remove: string[] (AgentProfile IDs to remove)

  // 1. 查当前 Channel.members (JSON parse)
  // 2. add: members = [...new Set([...members, ...add])]
  // 3. remove: members = members.filter(id => !remove.includes(id))
  // 4. prisma.channel.update({ data: { members: JSON.stringify(members) } })
  // 5. res.json({ success: true, data: { members } })
});
```

### AC-B3：Channel 创建时指定成员

```typescript
// channel.routes.ts — POST / 改动

// 现有 body: { name, type? }
// 改为: { name, type?, members?: string[] }

router.post('/', async (req, res) => {
  const { name, type, members } = req.body;
  // ... 现有逻辑 ...
  // 新增: members ? JSON.stringify(members) : '[]'
  const channel = await prisma.channel.create({
    data: { name: fullName, type: type || 'rnd', members: members ? JSON.stringify(members) : '[]' },
  });
});
```

### AC-B4：前端 @mention 按 Channel 过滤

```typescript
// channel.ts (API client) — 改动

// 现有：
listAgents: () => fetch('/agent-profiles?status=active').then(...)

// 改为：
listAgents: (channelId?: string) => {
  const params = new URLSearchParams({ status: 'active' });
  if (channelId) params.set('channelId', channelId);
  return fetch(`/agent-profiles?${params}`).then(...)
}
```

```typescript
// ChannelInput.tsx — 改动

// 现有：useEffect 中 channelApi.listAgents() → 全量 active
// 改为：useEffect 中 channelApi.listAgents(channelId) → 按 channel 过滤

// channelId 从 props 传入（ChannelDetailPage → ChannelInput）
// 当 channelId 变化时重新获取 agent 列表
```

### AC-C2：Agent 消息写入 Thread

```typescript
// agent-loop.ts — postToDiscussionSpace 改动

private async postToDiscussionSpace(workUnitId: string, content: string): Promise<void> {
  const wu = await prisma.workUnit.findUnique({ where: { id: workUnitId } });
  if (!wu?.channelId) return;

  // 新增：查找锚点消息（该 WorkUnit 的第一条消息）
  const anchorMessage = await prisma.channelMessage.findFirst({
    where: { workUnitId, replyToId: null },
    orderBy: { createdAt: 'asc' },
  });

  await prisma.channelMessage.create({
    data: {
      content,
      workUnitId,
      channelId: wu.channelId,
      authorType: 'agent',
      agentName: this.role.name,
      replyToId: anchorMessage?.id ?? null,  // 新增
    },
  });
}
```

### AC-C3：Thread 视图渲染

```typescript
// ChannelDetailPage.tsx — 改动

// 消息分组逻辑（新增）：
// 1. 锚点消息：workUnitId 非空 && replyToId 为空
// 2. Thread 回复：replyToId 指向锚点消息
// 3. 普通消息：workUnitId 为空 && replyToId 为空

// 渲染结构：
// - 锚点消息渲染为 Thread 头部（显示回复数量 badge）
// - 点击展开/折叠 Thread 内回复
// - Thread 内回复缩进显示

interface ThreadGroup {
  anchor: ChannelMessage;       // 锚点消息
  replies: ChannelMessage[];    // 回复消息
}

function groupMessages(messages: ChannelMessage[]): (ChannelMessage | ThreadGroup)[] {
  // 1. 找出所有锚点消息（workUnitId && !replyToId）
  // 2. 找出所有 Thread 回复（replyToId 指向锚点）
  // 3. 按时间顺序排列：锚点 + 其回复为一组，普通消息独立
}
```

```typescript
// ChannelMessageItem.tsx — 改动

// 新增 props：
// - isThreadAnchor?: boolean
// - threadReplyCount?: number
// - isThreadReply?: boolean
// - isExpanded?: boolean
// - onToggleThread?: () => void

// 锚点消息：底部显示 "N 条回复" 可点击
// Thread 回复：左侧缩进 + 竖线
```

### AC-D1：项目发现服务

```typescript
// project-discovery.service.ts — 新文件

interface LocalProject {
  name: string;
  path: string;
  hasClaudeMd: boolean;
  language?: string;
}

class ProjectDiscoveryService {
  private cache: LocalProject[] | null = null;
  private cacheTime: number = 0;
  private readonly CACHE_TTL = 60_000; // 1 分钟
  private readonly roots: string[];     // 从环境变量或默认值

  constructor() {
    this.roots = (process.env.STUDIO_PROJECTS_ROOT || '~/projects/').split(':');
  }

  /** 扫描根目录，检测项目标志 */
  async discover(): Promise<LocalProject[]>

  /** 模糊搜索 */
  async search(query: string): Promise<LocalProject[]>

  /** 清除缓存 */
  invalidateCache(): void

  // 内部方法：
  private async scanDirectory(dir: string, depth: number): Promise<LocalProject[]>
  private async isProject(dir: string): Promise<{ isProject: boolean; hasClaudeMd: boolean; language?: string }>
}

// 项目检测逻辑：
// 检测标志：CLAUDE.md | package.json | .git/
// 嵌套项目（monorepo）：只检测顶层 + 一级子目录
// language 检测：从 package.json 取 "javascript"/"typescript"，从 go.mod 取 "go"，等
```

### AC-D2：WorkUnit.projectPath

```prisma
// schema.prisma — WorkUnit model 新增

model WorkUnit {
  // ... 现有字段 ...
  projectPath String?  // 本地项目路径（用于 Agent 执行 cwd）
}
```

```typescript
// workunit.service.ts — create 方法改动

// 现有 create input 新增 projectPath?: string
// create data 新增: projectPath: input.projectPath ?? null
```

```typescript
// agent-loop.ts — agentStep 改动

// 现有：spawn CLI 时 cwd = 默认路径
// 改为：
async agentStep(wu: WorkUnit): Promise<AgentResult> {
  const cwd = wu.projectPath || this.role.defaultPath || process.cwd();
  // spawn CLI with cwd
}
```

### AC-D3：项目发现 API

```typescript
// project.routes.ts — 新文件

// GET /api/v1/projects/discover
router.get('/discover', async (req, res) => {
  const { search } = req.query;
  const service = new ProjectDiscoveryService();
  const projects = search
    ? await service.search(search as string)
    : await service.discover();
  res.json({ success: true, data: projects });
});
```

### AC-E1：Convert to Task API

```typescript
// channel.routes.ts — 新增端点

// POST /api/v1/channels/:id/messages/:messageId/convert-to-task
router.post('/:id/messages/:messageId/convert-to-task', async (req, res) => {
  const { id: channelId, messageId } = req.params;
  const { title, description, assigneeId, projectPath } = req.body;

  // 1. 查原始消息
  const message = await prisma.channelMessage.findUnique({ where: { id: messageId } });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.workUnitId) return res.status(400).json({ error: 'Message already has WorkUnit' });

  // 2. 创建 WorkUnit
  const workUnit = await workUnitService.create({
    scope: title || message.content,
    channelId,
    type: 'task',
    status: assigneeId ? 'active' : 'unassigned',
    assigneeId: assigneeId ?? null,
    projectPath: projectPath ?? null,
    metadata: { creationMode: 'convert', originalMessageId: messageId, description },
  });

  // 3. 原始消息更新 workUnitId → 成为 Thread 锚点
  await prisma.channelMessage.update({
    where: { id: messageId },
    data: { workUnitId: workUnit.id },
  });

  res.status(201).json({ success: true, data: workUnit });
});
```

### AC-E2：LLM 预填建议

```typescript
// convert-to-task.service.ts — 新文件

interface ConvertSuggestion {
  title?: string;
  description?: string;
  suggestedAssigneeId?: string;
  suggestedProjectPath?: string;
}

class ConvertToTaskService {
  /** 调 LLM 分析消息内容，返回建议 */
  async suggest(
    messageContent: string,
    agents: Array<{ id: string; name: string; description?: string }>,
    projects: Array<{ name: string; path: string }>,
  ): Promise<ConvertSuggestion>

  // 实现：
  // 1. 构建 prompt：消息内容 + 可用 Agent 列表 + 可用项目列表
  // 2. 调 Claude API（或现有 LLM 集成）
  // 3. 解析响应为 ConvertSuggestion
  // 4. 超时 5s → 返回空建议
  // 5. LLM 失败 → 返回空建议（不阻断）
}
```

```typescript
// channel.routes.ts — 新增端点

// POST /api/v1/channels/:id/messages/:messageId/convert-to-task/suggest
router.post('/:id/messages/:messageId/convert-to-task/suggest', async (req, res) => {
  const { id: channelId, messageId } = req.params;

  // 1. 查消息内容
  // 2. 查可用 Agent 列表（active AgentProfiles）
  // 3. 调项目发现服务获取项目列表
  // 4. 调 ConvertToTaskService.suggest()
  // 5. 返回建议（可能为空）
});
```

### AC-E3：前端 Convert to Task UI

```typescript
// ConvertToTaskDialog.tsx — 新组件

interface ConvertToTaskDialogProps {
  open: boolean;
  onClose: () => void;
  messageId: string;
  channelId: string;
  messageContent: string;
  onConverted: (workUnit: WorkUnit) => void;
}

// 流程：
// 1. 打开 → 调 POST /convert-to-task/suggest → 预填表单
// 2. 表单字段：
//    - 标题（text input，预填 LLM 建议）
//    - 描述（textarea，预填 LLM 建议）
//    - 分配给（select，选项 = active AgentProfiles）
//    - 项目（select，选项 = GET /projects/discover 结果）
// 3. 确认 → 调 POST /convert-to-task → onConverted(workUnit)
// 4. Loading 状态（suggest 调用 + convert 调用）
```

```typescript
// ChannelMessageItem.tsx — 改动

// 新增：hover 时显示操作按钮区域
// - 已有：回复按钮（↩）
// 新增：转为任务按钮（📋）
// 条件：message.workUnitId 为空 && message.authorType === 'human'

// 点击 → 打开 ConvertToTaskDialog
```

```typescript
// channel.ts (API client) — 新增方法

convertToTask: (channelId: string, messageId: string, data: {
  title?: string;
  description?: string;
  assigneeId?: string;
  projectPath?: string;
}) => fetch(`/channels/${channelId}/messages/${messageId}/convert-to-task`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
}).then(...)

suggestTask: (channelId: string, messageId: string) =>
  fetch(`/channels/${channelId}/messages/${messageId}/convert-to-task/suggest`, {
    method: 'POST',
  }).then(...)

discoverProjects: (search?: string) => {
  const params = search ? `?search=${encodeURIComponent(search)}` : '';
  return fetch(`/projects/discover${params}`).then(...)
}
```

---

## 代码依赖图

```
Phase 1 (Schema):
  schema.prisma (Channel.members + WorkUnit.projectPath)
    → migration
    → 所有后端改动的前置

Phase 2 (独立后端，可并行):
  message-routing.ts ← 无新依赖
  agent-profile.service.ts ← 无新依赖
  project-discovery.service.ts ← 纯新模块，无依赖
  agent-loop.ts (postToDiscussionSpace) ← 无新依赖

Phase 3 (依赖后端 API):
  channel.routes.ts (members + convert-to-task) ← 依赖 schema + project-discovery
  project.routes.ts ← 依赖 project-discovery
  workunit.service.ts ← 依赖 schema (projectPath)

Phase 4 (前端，依赖后端 API):
  channel.ts (API client) ← 依赖所有后端 API
  ChannelInput.tsx ← 依赖 channel.ts.listAgents(channelId)
  ChannelDetailPage.tsx ← 依赖消息结构变更
  ChannelMessageItem.tsx ← 依赖 thread 渲染 + convert-to-task
  ConvertToTaskDialog.tsx ← 依赖 channel.ts.convertToTask + discoverProjects
```

---

## 模块边界

| 边界 | 说明 |
|------|------|
| project-discovery vs Project 模型 | 完全独立。Project 是 PMO 模型，project-discovery 是本地扫描服务 |
| Channel.members vs AgentProfile.channels | 新字段 members 在 Channel 侧。AgentProfile.channels 保留不删（"不做"） |
| postToDiscussionSpace vs ChannelMessageService | 不改创建方式，只加 replyToId。SSE 缺失不在本 Phase |
| Convert to Task vs @mention | 两种 WorkUnit 创建路径，互不干扰。@mention 走 message-routing，convert 走独立端点 |
| projectPath vs projectId | 直接存路径，不经 Project 表。与 PMO 的 Project 模型完全隔离 |
