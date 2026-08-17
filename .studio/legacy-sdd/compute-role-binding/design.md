---
status: done
version: "1.0"
slug: compute-role-binding
title: 算力→角色绑定 — design
created: 2026-07-14
tags:
  - agent-network
  - agent-profile
  - provider
---

## 文件映射表

| AC | 文件 | 变更 | 说明 |
|----|------|------|------|
| AC-1.1 | `packages/studio-shared/src/file-store.ts` | 修改 | AgentProfileData + `provider: string \| null` |
| AC-1.2~1.5 | `apps/api/src/modules/agents/agent-profile.service.ts` | 修改 | CreateAgentProfileInput/UpdateAgentProfileInput + provider；list() + provider 过滤 |
| AC-1.2~1.3 | `apps/api/src/modules/agents/agent-profile.routes.ts` | 修改 | POST/PATCH body 提取 provider |
| AC-2.1~2.3 | `apps/api/src/modules/agents/agent-loop.ts` | 修改 | 删硬编码 `'claude'`，读 `this.role.provider` |
| AC-3.1~3.3 | `apps/api/src/modules/channels/channel.routes.ts` | 修改 | `createAgentWithFileStore` + provider 参数 |
| AC-4.1~4.2 | `apps/api/src/modules/workspaces/workspace.routes.ts` | 修改 | 新增 GET /:id 路由（含 runtimes include） |
| AC-5.1~5.5 | `apps/web/src/pages/WorkspacePage.tsx`（新建） | 新建 | runtime 列表 + 创建角色弹框 |
| AC-5.4 | `apps/web/src/api/index.ts` | 修改 | workspaceApi.get() 返回 runtimes（后端路由补齐后自动通） |

## 接口定义

### 1. AgentProfileData

```typescript
// file-store.ts
export interface AgentProfileData {
  id: string;
  name: string;
  description: string | null;
  channels: string;        // JSON: Channel ID[]
  status: string;          // active | inactive
  provider: string | null; // 新增: claude | codex | opencode | openclaw | null
  createdAt: string;
  updatedAt: string;
}
```

### 2. CreateAgentProfileInput / UpdateAgentProfileInput

```typescript
// agent-profile.service.ts
export interface CreateAgentProfileInput {
  name: string;
  description?: string;
  channels?: string[];
  provider?: string;       // 新增
  status?: string;
}

export interface UpdateAgentProfileInput {
  name?: string;
  description?: string | null;
  channels?: string[];
  provider?: string | null;  // 新增（null 可清除）
  status?: string;
}
```

### 3. AgentProfileService.list()

```typescript
async list(options?: {
  status?: string;
  channelId?: string;
  provider?: string;        // 新增
  page?: number;
  limit?: number;
}): Promise<{ data: AgentProfileWithOnline[]; total: number }>
```

provider 过滤：`options.provider ? profiles.filter(p => p.provider === options.provider) : profiles`

### 4. AgentLoop.agentStep()

```typescript
// agent-loop.ts
const task: AgentTask = {
  // ...
  provider: (this.role.provider as string) || 'claude',  // was: 'claude'
  // ...
};
```

### 5. createAgentWithFileStore()

```typescript
// channel.routes.ts
async function createAgentWithFileStore(
  fs: FileStore,
  name: string,
  description: string | null,
  channelId: string,
  provider?: string,         // 新增
): Promise<AgentProfileData>
```

### 6. GET /workspaces/:id（新增）

```typescript
// workspace.routes.ts
router.get('/:id', async (req, res) => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: req.params.id },
    include: { runtimes: true },
  });
  if (!workspace) return res.status(404).json({ error: 'not found' });
  res.json({ data: workspace });
});
```

### 7. 前端 WorkspacePage（新建）

```
/workspaces/:id 路由
  ├─ Workspace 基本信息（name, status, lastHeartbeat）
  ├─ Runtime 列表
  │   └─ 每行: provider icon + version + status + [创建角色] + 已绑定 N 个角色
  └─ 创建角色弹框
      ├─ name input（必填）
      ├─ description input（选填）
      ├─ provider（自动填充，不可编辑）
      └─ [创建] [取消]
```

## 代码依赖图

```
file-store.ts (AgentProfileData + provider)
  ├─ agent-profile.service.ts (create/update/list)
  │   └─ agent-profile.routes.ts (POST/PATCH)
  │
  ├─ channel.routes.ts (createAgentWithFileStore)
  │
  └─ agent-loop.ts (this.role: AgentProfileData)
      └─ agentStep() → task.provider

workspace.routes.ts (GET /:id)
  └─ WorkspacePage.tsx → workspaceApi.get(id) → runtimes 列表
      └─ 创建角色 → POST /agent-profiles { provider }

无循环依赖。Step 1 是叶子节点。
```
