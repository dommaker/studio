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

### RL-01 速率限制中间件

**Implementation Notes**
在 `apps/api/src/modules/workspaces/middleware.ts` 创建中间件：
- 导入 `express-rate-limit` 和 `crypto`
- 用 `rateLimit()` 创建实例，导出为 `workspaceRateLimit`
- keyGenerator 函数逻辑：
  1. `req.params.id` 存在 → 返回 `ws:${req.params.id}`
  2. `req.headers.authorization` 存在 → 返回 `ws-token:${sha256(authHeader).substring(0, 16)}`
  3. fallback → `ip:${req.ip}`
- 配置：`windowMs: 60_000`, `max: 100`, `standardHeaders: true`, `legacyHeaders: false`
- message: `{ error: 'Workspace rate limit exceeded', retryAfter: '60s' }`

**Architecture Context**
- Functions: `workspaceRateLimit: RequestHandler @ modules/workspaces/middleware.ts:1-30`
- Call Chain: `route-registry.ts → app.use(path, workspaceRateLimit, router)`
- Imports: `import rateLimit from 'express-rate-limit'`, `import crypto from 'crypto'`
- TypesInScope: `Request` from `express`
- Danger Zones: 不改 `middleware/rate-limit.ts` 现有 IP 级别限制

**Code Patterns**
- 复用 `express-rate-limit` 库，与 `middleware/rate-limit.ts` 风格一致
- keyGenerator 用同步操作，不做 DB 查询

**Gotchas**
- `workspaceAuth()` 在 router 内执行，rate limiter 先于 auth 运行
- 因此 daemon 端点用 auth header hash 作为 key，不是 `req.workspace.id`
- 同一 token hash 1:1 映射到 workspace，效果等价

### RL-02 路由挂载

**Implementation Notes**
在 `apps/api/src/route-registry.ts` 中：
1. 添加 import: `import { workspaceRateLimit } from './modules/workspaces/middleware.js'`
2. 修改 workspaceRoutes 条目：`{ path: '/api/v1/workspaces', router: workspaceRoutes, middleware: [workspaceRateLimit], ... }`
3. 修改 daemonRoutes 条目：`{ path: '/api/v1/daemon', router: daemonRoutes, middleware: [workspaceRateLimit], ... }`
4. 修改 taskRoutes 条目：`{ path: '/api/v1/workspaces', router: taskRoutes, middleware: [workspaceRateLimit], ... }`

**Architecture Context**
- Functions: 无新函数，仅配置变更
- Call Chain: `buildRouteTable() → route entries with middleware → app.use(path, mw, router)`
- Imports: 新增 `import { workspaceRateLimit } from './modules/workspaces/middleware.js'`
- Danger Zones: 不改 app.ts 的挂载逻辑（已有 middleware 字段支持）

**Code Patterns**
- 与现有 `mcpRateLimit` 在 route-registry 中的使用模式一致

**Gotchas**
- token.routes.ts 不加限制（管理操作，频率低）
