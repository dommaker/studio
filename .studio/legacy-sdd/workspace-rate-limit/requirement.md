---
id: "workspace-rate-limit-001"
slug: "workspace-rate-limit"
title: "Workspace 级别速率限制"
status: "done"
tier: fast
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
tags: ["workspaces", "rate-limit", "middleware"]
createdAt: "2026-06-18T00:00:00Z"
updatedAt: "2026-06-18T00:00:00Z"
---

## 一句话总结
每个 workspace 每分钟最多 100 次 API 调用，超限返回 429，使用内存计数器。

## 背景
daemon 端点（heartbeat/register/task-claim）调用频率高，需要按 workspace 粒度限流，防止单个 workspace 压垮 API。现有 `middleware/rate-limit.ts` 是 IP 级别，不满足需求。

## AC Groups

### RL-01 速率限制中间件

#### 验收标准
- [ ] 创建 `modules/workspaces/middleware.ts`，导出 `workspaceRateLimit` (express.RequestHandler)
- [ ] 使用 `express-rate-limit` 库，windowMs = 60_000，max = 100
- [ ] keyGenerator: 优先 `req.workspace?.id`，其次 `req.params.id`，fallback `req.ip`
- [ ] 超限返回 429，响应体 `{ error: "Workspace rate limit exceeded", retryAfter: "60s" }`
- [ ] 返回 `RateLimit-*` 标准 headers（standardHeaders: true）
- [ ] 不使用 legacyHeaders

#### 涉及文件
- apps/api/src/modules/workspaces/middleware.ts (新建)

#### 依赖: 无

### RL-02 路由挂载

#### 验收标准
- [ ] 在 `route-registry.ts` 中导入 `workspaceRateLimit`
- [ ] 给 workspaceRoutes 条目添加 `middleware: [workspaceRateLimit]`
- [ ] 给 daemonRoutes 条目添加 `middleware: [workspaceRateLimit]`
- [ ] 给 taskRoutes 条目添加 `middleware: [workspaceRateLimit]`
- [ ] 不影响其他模块的路由

#### 涉及文件
- apps/api/src/route-registry.ts

#### 依赖: RL-01

## 非目标
- 不替换现有 IP 级别 rate-limit（`middleware/rate-limit.ts`）
- 不做 Redis 持久化（内存 Map 足够）
- 不做 per-endpoint 差异化限制
- 不改 token.routes.ts（token 管理是管理操作，频率低）
