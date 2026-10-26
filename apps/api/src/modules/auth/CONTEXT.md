# apps/api/src/modules/auth

### 职责

负责 API 用户认证与会话管理，包括注册、登录、Guest Session 创建、认证状态查询及 JWT 令牌管理。同时集成 OAuth 认证流程（参见 oauth.routes.ts 与 oauth.service.ts）和邮件验证（email.service.ts），并支持可配置的认证模式（none / on）。

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
- **Guest session `userId=null`**（service.ts createGuestSession 不建用户记录）→ `findSessionWithUser` 查不到用户 → guest token 实际过不了 `requireAuth()`/Lurk Wall 大门，等同匿名（2026-07-24 生产实测确认）。Lurk Wall 的"guest 可围观"实际由 PUBLIC_API 白名单前缀承载（/channels、/requirements-docs 等，无需任何 token）
- 注册用户 role 恒为 `"User"`（service.ts:307）；`/auth/register` 不在 PUBLIC_API，生产上仅已过大门者（即 Admin）可创建用户
- **注册默认关闭（2026-08-25 收口）**：`POST /auth/register` 首行检查 `REGISTER_ENABLED === "true"`，否则 403「注册已关闭」；单租户自托管口径，现有用户不受影响。登录失败文案统一为「邮箱或密码错误」，不再区分账号是否存在
- **限频分桶依赖 trust proxy（2026-08-25）**：app.ts 设 `app.set('trust proxy', 1)`（单跳反代），rate limit 按真实客户端 IP 分桶；apiRateLimit 全局挂 `/api`、mcpRateLimit 挂 MCP 路由，均 `skip` 回环直连（本机 daemon 共享 127.0.0.1，不限频防误伤）；authRateLimit/refreshRateLimit 不 skip
- **optionalAuth 支持 ?token= query 兜底（2026-08-25）**：EventSource 无法设 Authorization 头，/events/stream 经 query 携带 JWT；应用层日志记 req.path 不含 query 不落 token（nginx access.log 会记完整 URI）。
- 中间件分层（middleware/auth.ts，2026-07-24 收紧）：`requireAuth+requireNotGuest` = 内容写（User+Admin）；`requireAuth+requireAdmin` = 敏感/控制；`requireLocalhost` = 内部本机端点（/api/knowledge、/mcp/messages|sse、POST /mcp）——2026-08-25 修复同机反代绕过：带 X-Forwarded-For/CF-Connecting-IP 头即 403（nginx/cloudflared 同机时公网流量 TCP 对端也是回环）。三者 + requireRole 在 `STUDIO_AUTH=none` 下均放行，本地免登录不受影响。全量路由审查表见 `docs/plans/2026-07-api-auth-tightening.md`
- **Agent 服务身份（SEC-05，2026-10-27）**：`sta_` 凭证由 shared `agent-identity` 按 execution 签发、短期内存保存并随 sandbox dispose 吊销，不是 JWT/Operator Session。broker 另持独立 `sab_` 来源标记，plain HTTP 覆盖注入，app 以该标记识别 Agent 执行面；省略 token、伪造非 sta token 或无 token callback 均不能进入 Admin/localhost 面。全局 allowlist 只放行 `POST /api/v1/executions/events`；callback 同时校验 marker、sta 和 body executionId（必须字符串且恒等），其他 HTTP/MCP/本机控制面即使在 `STUDIO_AUTH=none` 也统一 `{error:{code,message}}` 403 且零 handler 副作用。legacy 无 broker 标记本机 runtime 仍走 `requireLocalhost`，普通 Operator 无标记请求不变。统一 Principal 归 SEC-07。
- **契约驱动迁移（2026-10 批次 6/7）**：八端点全走 core/http.ts defineRoute——register/login email+password 与 refresh refreshToken 必填收进 zod（原 service 抛错/手写 400 同状态码、文案变 zod 格式）；全部响应 `{ data }` 壳（token 响应形状与前端 authStore 消费双端核对）；错误 `{ error: string }` 统一 `{ error: { code, message } }`（401/403/409/400 业务拒绝文案保留，500 message 原样透传）；SEC-010 审计埋点（成功/失败双路径）与速率限制挂载原样保留。前端 authApi 的 getOAuthUrl/forgotPassword/resetPassword 为无后端路由死面（本批未动，清退另案）。
- **Refresh 生命周期与原子写（SEC-06，2026-10-27）**：`AuthSessionStore` 是 users/sessions 唯一写口，所有 RMW 共用 `auth.lock` 且经 `readJsonUncached` 裸读磁盘真值（锁外查询仍走 `readJson` 缓存）；refresh 在锁内完成 7 天 idle、30 天 absolute、revoked 校验及旧 Session 撤销，新 Session 继承同一 family 和原 absolute 截止时间。legacy 行以 `familyId=session.id`、`createdAt+30d` 迁移，明文 refresh token 在后续写入时转为 SHA-256 hash；新凭证只落 hash。相同进程内并发轮换复用同一结果，跨进程已消费 token 在 30 秒窗口内返回可重试 409，前端复用其他标签页已保存的新凭证且不清空登录态；消费标记只存 hash，随机无效 token 不触发 family 撤销。本票不启用 family 重用检测。logout 只撤当前 family，兼容注册面在锁内保证重复邮箱只有一个成功。
