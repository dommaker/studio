# auth

> 此文件描述 apps/api/src/modules/auth 目录的职责和上下文

## 职责

负责 API 用户认证与会话管理，包括注册、登录、Guest Session 创建、认证状态查询及 JWT 令牌管理。同时集成 OAuth 认证流程（参见 oauth.routes.ts 与 oauth.service.ts）和邮件验证（email.service.ts），并支持可配置的认证模式（none / on）。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `register` | service.ts | 用户注册，返回用户、会话及 JWT 令牌 |
| `getOrCreateSession` | service.ts | 根据 guestId 创建或复用 Guest Session |
| `getCurrentUser` | service.ts | 通过 sessionId 获取当前用户信息 |
| `UserData` / `SessionData` | service.ts | 用户与会话的数据结构类型 |
| `AuthResult` / `LoginInput` / `RegisterInput` | service.ts | 公共接口类型 |
| `JWT_SECRET` / `JWT_EXPIRES_IN_SECONDS` | service.ts | JWT 配置常量 |
| `router` (默认导出) | routes.ts | Express 路由实例，注册 /api/v1/auth/* 端点 |

## 依赖关系

**上游**
- `../../middleware/auth.js`（requireAuth、getAuthInfo、optionalAuth、requireRole）
- `../../middleware/rate-limit.js`（authRateLimit、refreshRateLimit）
- `@dommaker/studio-audit`（AuditService 用于审计日志）
- `@dommaker/studio-shared`（FileStore、logger）
- `jsonwebtoken`、`bcryptjs`、`node:crypto`、`node:path`、`node:os`

**下游**
- `apps/api/src/middleware/auth.ts`（可能使用本目录的认证中间件或类型）
- `apps/api/src/modules/agents/ops-agent.service.ts`（通过导入使用认证服务）
- `apps/api/src/route-registry.ts`（注册本目录路由）

## 注意事项

- 使用 `FileStore` 替代 Prisma 存储用户和会话数据（`users.json` / `sessions.jsonl`）
- `JWT_SECRET` 在生产环境必须通过环境变量设置，否则启动报错
- 密码使用 `bcryptjs` 哈希存储
- 注册操作需记录审计日志（SEC-010）
- 支持两种认证模式：`none`（直接返回本地管理员用户）和 `on`（完整认证流程）
- Guest Session 有效期 24 小时，JWT 令牌有效期 7 天
- 路由中应用了速率限制中间件（authRateLimit）

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `008912d6`: db-removal): complete Spec 1 AC-2/3/6 — dead table cleanup
- ✅ `13f60e68`: db-removal): migrate 9 more files from Prisma → FileStore (Round 2)
- ✅ `0b2db57e`: oauth): return dynamic error message in route 500 response
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
