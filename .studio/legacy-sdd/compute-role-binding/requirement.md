---
status: done
version: "1.0"
slug: compute-role-binding
title: 算力→角色绑定 — requirement
created: 2026-07-14
tags:
  - agent-network
  - agent-profile
  - provider
  - compute
---

## AC Groups

### AC Group 1: AgentProfileData + provider 字段

**covers**: [AgentProfile 数据模型]

| # | AC | 边界 | 不做 |
|---|-----|------|------|
| AC-1.1 | `AgentProfileData` 有 `provider: string \| null` 字段 | 已有 profile（无 provider）向后兼容 | 不强制 provider 必填 |
| AC-1.2 | `POST /agent-profiles` body 传 `provider: "claude"` → 写入 profile.json | 非法 provider 值不拒绝 | 不校验 provider 枚举 |
| AC-1.3 | `PATCH /agent-profiles/:id` body 传 `provider: "codex"` → 更新成功 | 重复 name 报 409；profile 不存在报 404 | — |
| AC-1.4 | 不传 provider → 默认 null | 已有 agent 不受影响 | — |
| AC-1.5 | `AgentProfileService.list({ provider: "claude" })` 只返回 provider=claude 的 profile | provider=null 不被过滤 | 不修改 channelId 过滤逻辑 |

**Files**：`file-store.ts`、`agent-profile.service.ts`、`agent-profile.routes.ts`

### AC Group 2: AgentLoop 读 profile.provider

**covers**: [AgentLoop provider 解耦]

| # | AC | 边界 | 不做 |
|---|-----|------|------|
| AC-2.1 | `agent-loop.ts` 不含 `provider: 'claude'` 字面量 | grep 确认 | 不改 observe/resolveTarget/recordResult |
| AC-2.2 | `agentStep()` 构建 task.provider = `this.role.provider \|\| 'claude'` | role.provider = "codex" → task.provider = "codex" | — |
| AC-2.3 | role.provider 为 null/undefined → fallback `'claude'` | 向后兼容无 provider 的旧 profile | — |

**Files**：`agent-loop.ts`

### AC Group 3: createAgentWithFileStore + provider

**covers**: [Channel 创建时透传 provider]

| # | AC | 边界 | 不做 |
|---|-----|------|------|
| AC-3.1 | 签名 `createAgentWithFileStore(fs, name, description, channelId, provider?)` | 不传 → null | — |
| AC-3.2 | 创建 channel `agents: [{ name, provider: "claude" }]` → profile.provider = "claude" | provider 可选 | 不改成员管理 |
| AC-3.3 | 同 name（幂等）→ 返回已有 profile | — | — |

**Files**：`channel.routes.ts`

### AC Group 4: GET /workspaces/:id（缺失路由补全）

**covers**: [Workspace 详情 API]

| # | AC | 边界 | 不做 |
|---|-----|------|------|
| AC-4.1 | `GET /workspaces/:id` → 200 + workspace + runtimes[] | 不存在 → 404 | — |
| AC-4.2 | runtimes 含 `{ id, provider, name, version, status }` | 0 runtime → 空数组 | — |

**Files**：`workspace.routes.ts`

### AC Group 5: 前端 Workspace 页面 + 创建角色

**covers**: [前端交互]

| # | AC | 边界 | 不做 |
|---|-----|------|------|
| AC-5.1 | Workspace 页面显示 runtime 列表（provider + version + status） | API 失败 → 错误提示 | 不修改 ChannelMemberManager |
| AC-5.2 | runtime 旁有 "创建角色" 按钮 → 弹框（name + description） | — | 不改 JoinComputeDialog |
| AC-5.3 | provider 自动填充（来自 runtime），用户不可改 | — | — |
| AC-5.4 | 提交 → POST /agent-profiles { name, description, provider } → 201 | 重复 name → 提示错误 | — |
| AC-5.5 | 创建成功后显示 "已绑定 N 个角色" | — | — |

**Files**：新建 Workspace 页面组件

---

## 依赖

- 算力接入（WorkspaceRuntime 检测）：已通，不在此 scope
- Channel 成员管理（add/remove agent）：已通，不在此 scope
- AgentLoop 框架：已通

## 跨 AC 边界

| 场景 | 处理 |
|------|------|
| 创建角色后立即有 WorkUnit → AgentLoop 领取 → spawn CLI | provider=claude → claude CLI；无 provider → fallback claude |
| provider 设 "codex" 但 codex 未安装 | AgentLoop spawn 失败 → stuck → blocked → 人类介入 |
| 一个 CLI 创建多个角色 | Executor + Reviewer 都用 claude → 各自独立 |
| 旧 profile.json 缺 provider 字段 | agent-loop.ts fallback `'claude'` |
| 重复 name 创建 | AgentProfileService 拒绝 409 |
