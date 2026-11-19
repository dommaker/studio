# apps/api/src/modules/auth

### 职责

负责单 Operator 认证、Guest 匿名 Session、JWT/refresh 生命周期与短期流式票据。支持 none / on 两种模式；当前仓内没有 OAuth 或邮件验证实现，前端同名死面不构成后端能力。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| index.ts | 模块公共出口（barrel） | P2-c 立界：跨模块唯一合法 import 面（实际消费反推生成）；深路径 import 由 eslint `local/no-deep-module-import` 拦截 |
| `register` | service.ts | 用户注册，返回用户、会话及 JWT 令牌 |
| `getOrCreateSession` | service.ts | 根据 guestId 创建或复用 Guest Session |
| `getCurrentUser` | service.ts | 通过 sessionId 获取当前用户信息 |
| `UserData` / `SessionData` | auth-session-store.ts（service.ts re-export） | 用户与会话的数据结构类型 |
| `AuthSessionStore` | auth-session-store.ts | users/sessions 唯一写口；锁内 refresh 轮换、family 撤销与并发注册 |
| `AuthResult` / `LoginInput` / `RegisterInput` | service.ts | 公共接口类型 |
| `JWT_SECRET` | service.ts | JWT 配置常量 |
| `router` (默认导出) | routes.ts | Express 路由实例，注册 /api/v1/auth/* 端点 |

### 依赖关系

**上游**
- `../../middleware/auth.js`（requireAuth、getAuthInfo、optionalAuth、requireRole）
- `../../middleware/rate-limit.js`（authRateLimit、refreshRateLimit）
- `./audit-sink.ts`（SEC-010 审计出口缝，Phase 5 SCC 第一刀 #1，2026-10-16）：`AuthAuditEntry`/`AuthAuditSink` 接口 + `registerAuthAuditSink(fn|null)` 注册口 + `logAuthAudit(entry)` 调用入口，实现由 bootstrap/module-sinks.ts 装配期注入（audit-logs 的 AuditService.log）；auth 不再 import audit-logs。**未注册语义：warn 一次 + 丢弃（no-op）**——审计失败在 routes.ts 本就降级 logger.error 不阻断请求，注册缺失按同级口径
- `@dommaker/studio-shared`（FileStore、logger）
- `jsonwebtoken`、`bcryptjs`、`node:crypto`、`node:path`、`node:os`

**下游**
- `apps/api/src/middleware/auth.ts`（可能使用本目录的认证中间件或类型）
- `apps/api/src/modules/agents/ops/ops.service.ts`（通过导入使用认证服务）
- `apps/api/src/route-registry.ts`（注册本目录路由）

### 注意事项

- 使用 `FileStore` 替代 Prisma 存储用户和会话数据（`users.json` / `sessions.json`）
- **#525 P2-3（2026-09-12，#517 项④）**：`writeSessionsLocked` 落盘前顺带 prune 过期条目，sessions.json 不再只涨不清；SEC-06 已消费 token 的旧 Session 仅为并发重试保留最多 30 秒，其余 logout/撤销条目随写入清理
- `JWT_SECRET` 在生产环境必须通过环境变量设置，否则启动报错
- 密码使用 `bcryptjs` 哈希存储
- 注册操作需记录审计日志（SEC-010）
- 支持两种认证模式：`none`（直接返回本地管理员用户）和 `on`（完整认证流程）
- Guest Session 有效期 24 小时；JWT 访问令牌有效期 24 小时；refresh idle 窗口 7 天，absolute 窗口 30 天且不随轮换延长
- 路由中应用了速率限制中间件（authRateLimit）
- **Guest session `userId=null`**：不建用户记录，不能通过 `requireAuth`/Lurk Wall，也不映射 Operator；仅保留匿名会话语义，不是可认证主体。
- **注册默认关闭**：`/auth/register` 不在 PUBLIC_API，路由另挂 `requireAuth + requireRole('Admin')`，且 `REGISTER_ENABLED !== 'true'` 时 403；ExposurePolicy 禁止外部暴露与 `REGISTER_ENABLED=true` 组合。注册产生的 legacy `User` 不获得新 Principal。
- **限频分桶依赖 trust proxy（2026-08-25）**：app.ts 设 `app.set('trust proxy', 1)`（单跳反代），rate limit 按真实客户端 IP 分桶；apiRateLimit 全局挂 `/api`、mcpRateLimit 挂 MCP 路由，均 `skip` 回环直连；authRateLimit/refreshRateLimit 不 skip。
- **SEC-07 流式票据**：`optionalAuth`/`requireAuth` 不再读取 query JWT。流式票据签发端点仅 Operator 可调用，签发 60 秒、单用途、绑定精确 SSE/附件 GET 资源的内存票据；`middleware/stream-ticket.ts` 在 Lurk Wall 前消费并只传内部 `streamSessionId`，长期 JWT、跨资源、过期和重放均 401，普通 PMO URL 的 query token 无效。前端按需取票，SSE 重连另取新票。
- **SEC-07 Principal 投影**：`middleware/auth.ts` 的 `AuthPrincipal` 只分 Operator/Agent/System；Admin 与本地 none 身份映射 Operator，legacy User/Guest 登录、refresh 和请求认证均失败，不按邮箱自动提权。`req.user` 不含 passwordHash，`req.session` 仅 `{id,userId}`，响应 `PublicSession` 不重复返回 access/refresh token。`requireAuth+requireNotGuest` 与 `requireAdmin` 都只接受 Operator；`requireLocalhost` 对真实无转发头回环内部调用投影 `system:localhost`，不接受 body/header 自声明，Operator-only 守卫拒绝 System。
- **Agent 服务身份（SEC-05/07）**：`sta_`/`sab_` 继续按 execution 验证并随 sandbox dispose 吊销；`requireAgentService` 另投影 `actorType='Agent'`，全局 allowlist 仍只放行 `POST /api/v1/executions/events`，未削弱 SEC-05 边界。
- **契约驱动迁移（SEC-07 + ARCH-01）**：九个 auth 端点走 core/http.ts defineRoute 并显式声明 response；全部响应 `{ data }` 壳，login/refresh 只在约定凭证字段返回值，`PublicSession` 只含 id/userId/guestId/expiresAt/createdAt。前端 getOAuthUrl/forgotPassword/resetPassword 仍是无后端路由死面。
- **Refresh 生命周期与原子写（SEC-06/07）**：`AuthSessionStore` 仍是 users/sessions 唯一写口，锁内裸读、idle/absolute/revoked 校验、family 撤销和并发重试语义不变。SEC-07 的 Operator 授权回调在同一把 `AUTH_LOCK` 内接收 `readUsersBare()` 的磁盘真值，不再经 `findUserById`/缓存；同 mtime 外部 role 降级或删除均拒绝且 Session 零写。logout 仍只撤当前 family。
