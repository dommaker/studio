# auth

> 此文件描述 apps/api/src/modules/auth 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/auth/CONTEXT.md, apps/api/src/modules/auth/service.ts, apps/api/src/modules/auth/routes.ts, apps/api/src/modules/auth/email.service.ts, apps/api/src/modules/auth/oauth.routes.ts, apps/api/src/modules/auth/oauth.service.ts

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
- `apps/api/src/modules/agents/ops.service.ts`（通过导入使用认证服务）
- `apps/api/src/route-registry.ts`（注册本目录路由）

## 注意事项

- 使用 `FileStore` 替代 Prisma 存储用户和会话数据（`users.json` / `sessions.jsonl`）
- `JWT_SECRET` 在生产环境必须通过环境变量设置，否则启动报错
- 密码使用 `bcryptjs` 哈希存储
- 注册操作需记录审计日志（SEC-010）
- 支持两种认证模式：`none`（直接返回本地管理员用户）和 `on`（完整认证流程）
- Guest Session 有效期 24 小时，JWT 令牌有效期 7 天
- 路由中应用了速率限制中间件（authRateLimit）
- **Guest session `userId=null`**（service.ts createGuestSession 不建用户记录）→ `findSessionWithUser` 查不到用户 → guest token 实际过不了 `requireAuth()`/Lurk Wall 大门，等同匿名（2026-07-24 生产实测确认）。Lurk Wall 的"guest 可围观"实际由 PUBLIC_API 白名单前缀承载（/channels、/requirements-docs 等，无需任何 token）
- 注册用户 role 恒为 `"User"`（service.ts:307）；`/auth/register` 不在 PUBLIC_API，生产上仅已过大门者（即 Admin）可创建用户
- 中间件分层（middleware/auth.ts，2026-07-24 收紧）：`requireAuth+requireNotGuest` = 内容写（User+Admin）；`requireAuth+requireAdmin` = 敏感/控制；`requireLocalhost` = 内部本机端点（/api/knowledge、/mcp/messages|sse）。三者 + requireRole 在 `STUDIO_AUTH=none` 下均放行，本地免登录不受影响。全量路由审查表见 `docs/plans/2026-07-api-auth-tightening.md`

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `240f7885`: passwordHash 泄露 + workspace 端点 Admin 加硬 + 本地 CLI 扫描修复
- ✅ 2026-07-24: API 鉴权收紧（姿态 A）— `requireNotGuest` 补 STUDIO_AUTH=none 放行分支；新增 `requireLocalhost` 中间件；确认 guest session（userId=null）实际过不了 requireAuth/大门，真实暴露面=PUBLIC_API 前缀+/api/knowledge；审查表 docs/plans/2026-07-api-auth-tightening.md
- ✅ `008912d6`: db-removal): complete Spec 1 AC-2/3/6 — dead table cleanup
- ✅ `13f60e68`: db-removal): migrate 9 more files from Prisma → FileStore (Round 2)
- ✅ `0b2db57e`: oauth): return dynamic error message in route 500 response
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
