---
status: done
version: "1.0"
slug: compute-role-binding
title: 算力→角色绑定 — task
created: 2026-07-14
tags:
  - agent-network
  - agent-profile
  - provider
---

## 契约测试

| AC | 测试文件 | 用例 |
|----|---------|------|
| AC-1.1 | — | read 验证 |
| AC-1.2 | `agent-profile.service.test.ts` | `create({ name, provider: "claude" })` → `.provider === "claude"` |
| AC-1.3 | `agent-profile.service.test.ts` | `update(id, { provider: "codex" })` → 读回 `.provider === "codex"` |
| AC-1.4 | `agent-profile.service.test.ts` | `create({ name })` → `.provider === null` |
| AC-1.5 | `agent-profile.service.test.ts` | create 两个 profile（claude + codex）→ `list({ provider: "claude" })` → 1 条 |
| AC-2.1 | — | `grep "provider: 'claude'" agent-loop.ts` → 0 |
| AC-2.2 | `agent-loop.test.ts` | mock role.provider = "codex" → task.provider = "codex" |
| AC-2.3 | `agent-loop.test.ts` | mock role.provider = null → task.provider = "claude" |
| AC-3.1~3.3 | `channel-members.test.ts` | channel agents `[{ name, provider }]` → profile.provider 正确 + 幂等 |
| AC-4.1~4.2 | `workspace.test.ts` | GET /:id → 200 + runtimes；不存在的 id → 404 |
| AC-5.1~5.5 | 新建 WorkspacePage.test.tsx | runtime 列表渲染 + 弹框交互 + 提交 API |

## 执行顺序

### 依赖 DAG

```
Step 1: file-store.ts ─────── 独立 ──────────┐
                                              │
Step 2: agent-profile.service + routes ───────┤ 依赖 Step 1
Step 3: channel.routes.ts ────────────────────┤ 依赖 Step 1
                                              │
Step 4: workspace.routes.ts ── 独立 ──────────┤
Step 5: agent-loop.ts ──────── 独立 ──────────┘

Step 6: WorkspacePage.tsx ← 依赖 Step 2, 4
```

### 并行化

```
Phase 1（并行）:
  Step 1: file-store.ts
  Step 4: workspace.routes.ts
  Step 5: agent-loop.ts

Phase 2（依赖 Step 1）:
  Step 2: agent-profile.service + routes
  Step 3: channel.routes.ts

Phase 3（依赖 Phase 1, 2）:
  Step 6: WorkspacePage.tsx
```

### 里程碑

| 节点 | 条件 | 验证 |
|------|------|------|
| M1 | Step 1-3 完成 | POST /agent-profiles { provider: "claude" } → 201 |
| M2 | Step 4-5 完成 | GET /workspaces/:id → 200 + runtimes；grep agent-loop.ts 无 'claude' |
| M3 | Step 6 完成 | Workspace 页面渲染 runtime，创建角色弹框可用 |
| M4 | 全量测试 | `pnpm test` 通过 |
