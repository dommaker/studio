---
id: "cmr01qh13005mg9d8dhfxakqf"
slug: "jwt-auth-system-token-refresh-oauth2-0"
title: "JWT 认证系统（Token 刷新 + OAuth2.0 第三方登录）"
status: "done"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
createdAt: "2026-06-30T02:47:27.987Z"
updatedAt: "2026-06-30T02:47:27.987Z"
---

## Design

### ac-jwt-core

**Implementation Notes**
JWT 签发/验证核心。payload 使用短字段名 {sid, uid} 减少 token 体积。密码哈希双格式兼容（bcryptjs + 旧 PBKDF2），旧格式登录成功自动升级。JWT_SECRET 在 production 缺少时 throw Error 阻断启动（fail-fast）。

**Architecture Context**
- Functions: hashPassword(password: string): string — bcrypt hashSync(cost=12), verifyPassword(password: string, storedHash: string): { valid: boolean; needsRehash: boolean } — 兼容 bcrypt + 旧 PBKDF2 salt:hash, generateToken(sessionId: string, userId?: string): string — jwt.sign({sid, uid}, JWT_SECRET, {expiresIn}), verifyToken(token: string): { sessionId: string; userId?: string } | null — jwt.verify 解析 payload.sid/uid
- Call Chain: service.ts:generateToken → jwt.sign → DB session.update(token) || service.ts:verifyToken → jwt.verify → middleware/auth.ts:verifyToken → 查 prisma.session
- Imports: jwt from 'jsonwebtoken', bcrypt from 'bcryptjs', crypto from 'crypto', prisma from '@dommaker/studio-prisma'
- Danger Zones: JWT payload 字段名 {sid, uid} 不可改为 {sessionId, userId} — oauth.service.ts 和所有消费方未同步则 token 验证失败, JWT_SECRET 使用不同 fallback 值时跨模块 token 验证失败 — 所有模块必须用同一个 JWT_SECRET, Password hash 可能为 null（OAuth-only 用户）— verifyPassword 需处理 null
- Verified At: apps/api/src/modules/auth/service.ts:87-108, 62-82, 53-55

**Code Patterns**
- 两步 Session 写入：先 create(空token) → jwt.sign → update(写入token)，防 DB 重建 token 丢失
- 密码兼容：按冒号数量判断格式（1 个冒号 = PBKDF2，0 个 = bcrypt），旧格式通过后返回 needsRehash=true

**Gotchas**
- 不可修改 JWT_EXPIRES_IN_SECONDS 不告知 — 前端无 JWT payload 解析，所有判断靠 /auth/me 端点
- requireAuth() 内部双重错误码格式：401 返回 {error, code} 分别有 UNAUTHORIZED/TOKEN_EXPIRED/SESSION_NOT_FOUND/SESSION_EXPIRED 四种

### ac-auth-endpoints

**Implementation Notes**
RESTful auth 端点，挂载在 /api/v1/auth 下。所有端点返回 AuthResult 结构。login 流程含 guest session 清理 + 密码静默升级。register 生成邮箱验证 token。审计日志 fire-and-forget 不阻断主流程。

**Architecture Context**
- Functions: login(input: LoginInput): Promise<AuthResult> — 查找用户 → 验证密码 → needsRehash → 清理 guest → 建 session → 返回, register(input: RegisterInput): Promise<AuthResult> — 检查 email 唯一 → 建用户 → 建 session → 返回, logout(sessionId: string, userId?: string): Promise<void> — 过期 session + 可选批量吊销 refresh token, getCurrentUser(sessionId: string): Promise<{ user, session }> — 查 session + User, createGuestSession(input: SessionInput): Promise<AuthResult> — 建 guest session (24h), getOrCreateSession(input: SessionInput): Promise<AuthResult> — 复用或建 guest session, cleanupExpiredSessions(): Promise<number> — 删过期 session, generateRefreshToken(userId: string): Promise<string> — crypto.randomBytes(64).hex，30 天
- Call Chain: routes.ts:POST/login → authRateLimit → authService.login → verifyPassword → needsRehash → prisma.session.deleteMany(guest) → prisma.session.create → generateToken → prisma.session.update → generateRefreshToken → auditService.log → res.json(AuthResult)
- Imports: Router from 'express', requireAuth/optionalAuth/requireRole from '../../middleware/auth.js', authRateLimit/refreshRateLimit from '../../middleware/rate-limit.js', * as authService from './service.js', AuditService from '@dommaker/studio-audit'
- Danger Zones: login() guest session 清理必须在 session.create 之前执行 — 否则新 session 可能被误删, requireAuth() 必须加括号调用 — 不加括号不报错但 auth 永不触发, auditService.log 调用失败不应阻断主流程（fire-and-forget），测试中不能 await
- Verified At: apps/api/src/modules/auth/routes.ts:25-278, apps/api/src/modules/auth/service.ts:145-367

**Code Patterns**
- 中间件工厂模式：requireAuth()/optionalAuth()/requireRole() 均返回 (req,res,next) 闭包，在路由中用 middleware: [requireAuth()] 数组挂载
- 错误响应：throw Error 在 routes 中 catch → res.status(code).json({error: message})，业务错误码 401/409/400

**Gotchas**
- schema.prisma User.role 默认值 'Guest' — register 中 hardcode 'User'，新增路径时要显式设 role
- POST /auth/refresh 返回 {accessToken, refreshToken, userId} — 字段名是 accessToken 不是 token
- Auth 端点（login/register/guest-session/refresh/me）必须绕过前端 401 refresh 逻辑，否则无限循环

### ac-refresh-token

**Implementation Notes**
Refresh token 轮转（rotation）防止重放攻击。并发安全通过 updateMany where { id, revokedAt: null } 实现原子吊销。检查 revoke.count===0 拒绝重复消费。新建 session + access token + refresh token 全套轮转。

**Architecture Context**
- Functions: exchangeRefreshToken(refreshToken: string): Promise<{ accessToken, refreshToken, userId } | null>, generateRefreshToken(userId: string): Promise<string> — crypto.randomBytes(64).hex, expire 30d, revokeRefreshToken(refreshToken: string): Promise<boolean>, logout(sessionId, userId?) — 内调用 updateMany revoke 所有 user refresh token
- Call Chain: routes.ts:POST/refresh → refreshRateLimit → authService.exchangeRefreshToken → prisma.refreshToken.findUnique → prisma.refreshToken.updateMany(原子吊销) → prisma.session.create → generateToken → prisma.session.update → generateRefreshToken → res.json({accessToken, refreshToken, userId})
- Imports: crypto from 'crypto' (randomBytes), prisma from '@dommaker/studio-prisma', generateToken (local import)
- Danger Zones: exchangeRefreshToken 先 revoke 再 create 的顺序不可改变 — 先 create 后 revoke 会导致并发窗口, updateMany where { id, revokedAt: null } 是关键并发安全机制 — 不可改为 update, Refresh token 30 天过期时间与 JWT 7 天独立 — 改一个不需要改另一个
- Verified At: apps/api/src/modules/auth/service.ts:353-437

**Code Patterns**
- 双重检查并发安全：先 findUnique 查有效性 → updateMany with revokedAt: null 条件 → 检查 revoke.count === 0 拒绝重复
- Rotation：旧 token 立即 revokedAt=now，新 token 全新生成（新 session + 新 access + 新 refresh）

**Gotchas**
- RefreshToken.revokedAt 已有值时 updateMany 幂等 — 重复撤销安全
- refresh 端点必须加入前端 AUTH_PATHS 排除列表 — 否则 refresh 失败触发 interceptor 递归
- Refresh token 的多 tab 场景 — 前端 isRefreshing/queue 为模块级变量，多 tab 不共享状态

### ac-oauth

**Implementation Notes**
OAuth2.0 原生实现（无 passport.js），支持 Google 和 GitHub。CSRF 防护用 httpOnly cookie 存 state。token 通过 URL fragment (#) 传回前端防止 Referer 泄漏。用户解析三路径：OAuthAccount → email 关联 → 新建。

**Architecture Context**
- Functions: getAuthorizationUrl(provider: OAuthProvider, state: string): string — 构建 OAuth 授权 URL, exchangeCode(provider: OAuthProvider, code: string): Promise<OAuthProfile> — 交换 code → profile, getOrCreateOAuthUser(profile: OAuthProfile): Promise<{ user, isNewUser }> — 三路径用户解析, OAuthError class — statusCode + message
- Call Chain: oauth.routes.ts:GET/:provider → crypto.randomBytes(32) → res.cookie(oauth_state) → oauthService.getAuthorizationUrl → res.redirect || oauth.routes.ts:GET/callback/:provider → verify state cookie → clearCookie → oauthService.exchangeCode → getOrCreateOAuthUser → create session → redirect frontend #fragment
- Imports: jwt from 'jsonwebtoken', crypto from 'crypto', prisma from '@dommaker/studio-prisma', generateRefreshToken and JWT_SECRET from './service.js', logger from '@dommaker/studio-shared'
- Danger Zones: state cookie 先 clear 后比较 — 若 clearCookie 失败则比较永远为 true（宽松但非漏洞因 cookie 未清除会继续匹配）, redirect_uri 路径格式 {base}/callback/{provider}（非 /{provider}/callback）— 错误则 OAuth 回调 404, Google token endpoint 用 POST form-urlencoded，GitHub 用 POST JSON + Accept: application/json — 混用则 token exchange 失败, OAuth error redirect 保持 query param — fragment 在 redirect 中可能丢失
- Verified At: apps/api/src/modules/auth/oauth.service.ts:27-76, apps/api/src/modules/auth/oauth.routes.ts:1-60

**Code Patterns**
- OAuth 用户解析三路径：① prisma.oAuthAccount.findUnique 按 provider+providerAccountId ② 按 email 查 User ③ prisma.user.create + prisma.oAuthAccount.create
- CSRF 防护：crypto.randomBytes(32) state → httpOnly cookie (SameSite=Lax, secure in production, 10min) → callback 验证后 clear
- Token 传回：成功 → URL fragment (#access_token=...&refresh_token=...)；错误 → query param (?error=...)

**Gotchas**
- 不可删除 oauth.routes.ts 的 state cookie CSRF 检查 — 安全漏洞：攻击者可构造回调 URL 绑定攻击者账户
- GitHub OAuth email 获取需额外请求 /user/emails (scope: user:email)，email 需 primary+verified 字段筛选
- Google id_token 直接包含用户信息（JWT 解码即可），无需额外 API 请求

### ac-session

**Implementation Notes**
Session 生命周期管理：guest session (24h) 和 user session (7d)。两步写入防止 token 丢失。Guest → User 迁移通过 login 时清理旧 guest session 实现。

**Architecture Context**
- Functions: createGuestSession(input: SessionInput): Promise<AuthResult> — 两步写入，24h 过期, getOrCreateSession(input: SessionInput): Promise<AuthResult> — 复用或创建 guest session, getCurrentUser(sessionId: string): Promise<{ user, session }> — 含过期检查, cleanupExpiredSessions(): Promise<number> — 批量删除
- Call Chain: middleware/auth.ts:optionalAuth/requireAuth → verifyToken → prisma.session.findUnique → 检查 expiresAt → 注入 req.session/user || routes.ts:guest-session → getOrCreateSession → createGuestSession → prisma.session.create(token='') → generateToken → prisma.session.update(token)
- Imports: prisma from '@dommaker/studio-prisma', jwt from 'jsonwebtoken', crypto from 'crypto'
- Danger Zones: 两步写入（先 create 空 token → jwt.sign → update 写 token）不可缩减为一步 — token 存 DB 涉及 session 重建需求, login 中 guest session 清理必须在 session.create 之前 — 否则可能误删新 session, getOrCreateSession 并发场景下可能创建重复 session — 需 prisma unique constraint 防护
- Verified At: apps/api/src/modules/auth/service.ts:113-166, 322-337

**Code Patterns**
- 分层过期策略：refresh token 30 天 > JWT 7 天 > Guest session 24h
- Guest session 通过 guestId (UUID) 标识，存储在 session.guestId 字段

**Gotchas**
- Guest session 24h 保持不变 — guest 不需要 7 天
- Session 过期检查在 middleware 和 getCurrentUser 两处都有

### ac-security

**Implementation Notes**
多层安全防护：速率限制（express-rate-limit，按 IP）、Lurk Wall 全局认证墙（PUBLIC_API 白名单）、CSRF state cookie、审计日志（fire-and-forget）、敏感信息脱敏日志。

**Architecture Context**
- Functions: authRateLimit: rateLimit({ windowMs: 60s, max: 10 }) — login/register/forgot/reset, refreshRateLimit: rateLimit({ windowMs: 60s, max: 20 }) — refresh, mcpRateLimit: rateLimit({ windowMs: 60s, max: 60 }) — MCP tools, apiRateLimit: rateLimit({ windowMs: 60s, max: 120 }) — 通用 API, optionalAuth(): middleware — 始终生成 anonymousId (SEC-009), requireAuth(): middleware — 强制认证，4 种错误码, requireRole(role): middleware — 角色守卫, generateAnonymousId(ip, ua): string — SHA256 日窗口匿名标识
- Call Chain: app.ts: Lurk Wall → 检查 PUBLIC_API.has(req.path) → 不在白名单则 requireAuth() || routes.ts: authRateLimit/refreshRateLimit → rateLimit middleware → req.ip keyGenerator || middleware/auth.ts: requireAuth → parseAuthHeader → verifyToken → prisma.session.findUnique → 检查 expiresAt → 注入 req.user/session
- Imports: rateLimit from 'express-rate-limit', verifyToken from '../modules/auth/service.js', prisma from '@dommaker/studio-prisma', logger from '../utils/logger.js', crypto from 'crypto' (generateAnonymousId)
- Danger Zones: PUBLIC_API 用 req.path 做 startsWith 匹配（不含 /api/v1 前缀）— 新增端点必须同步加入白名单, trust proxy 设置需正确配置 — express-rate-limit 默认 keyGenerator 使用 req.ip，反向代理配置不当则所有请求视为同一 IP, 不可删除 middleware/auth.ts 的 generateAnonymousId — SEC-009 下游 audit log 依赖
- Verified At: apps/api/src/middleware/rate-limit.ts:1-30, apps/api/src/middleware/auth.ts:56-62, apps/api/src/app.ts (Lurk Wall)

**Code Patterns**
- 速率限制使用 express-rate-limit，keyGenerator 默认 req.ip，standardHeaders 返回 RateLimit-* headers
- Lurk Wall：app.ts 中中间件先于路由执行，PUBLIC_API Set 存储白名单 path，production 环境强制启用

**Gotchas**
- Auth endpoints (login/register/guest-session/refresh/me) 必须加入 PUBLIC_API 白名单
- OAuth path (/auth/google, /auth/callback/google) 也必须加入 PUBLIC_API
- rate-limit.ts 的 authRateLimit 10/min 不可任意修改 — 暴力破解防护阈值

### ac-frontend

**Implementation Notes**
前端 axios interceptor 实现请求认证注入和 401 自动刷新。关键设计决策：(1) 直接从 localStorage 读 token 避免循环依赖 (2) refresh 用独立 axios 实例避免递归 (3) 并发 401 排队机制。

**Architecture Context**
- Functions: getStoredAuth(): { token, refreshToken } — 读 localStorage 'auth-storage' JSON, isAuthPath(url): boolean — 检查 url 是否在 AUTH_PATHS 列表中, refreshToken(refreshTokenValue): Promise<{ accessToken, refreshToken }> — 用独立 axios 实例调 POST /auth/refresh, api.interceptors.request.use — 注入 Authorization: Bearer <token>, api.interceptors.response.use — 401 → 排队/刷新/重试
- Call Chain: api request → request interceptor: getStoredAuth() → config.headers.Authorization = Bearer → send → 401 response → response interceptor: isAuthPath? skip : (isRefreshing? queue : refreshToken(refresh) → update localStorage → flushQueue → retry)
- Imports: axios from 'axios', API_BASE = import.meta.env.VITE_API_URL || '/api/v1'
- Danger Zones: Interceptor 绝对不可 import authStore — 循环依赖 (authStore.ts imports from '../api'), refresh 请求不可用 api 实例 — 会触发 interceptor 递归，必须用独立 axios, AUTH_PATHS 必须包含所有 auth 端点 — 遗漏则 401 响应触发无限递归, isRefreshing/failedQueue 为模块级变量 — 多 tab 不共享状态，可能重复刷新
- Verified At: apps/web/src/api/index.ts:1-120

**Code Patterns**
- 从 localStorage 直接读 JSON 而非通过 authStore — 避免循环依赖 (authStore.ts imports from '../api')
- 并发 401 排队：首个 401 触发 refresh → isRefreshing=true → 后续 401 进队列 → refresh 完成 → flushQueue(token) → 批量重试
- 独立 axios 实例做 refresh 请求 — 不受 interceptor 影响，防止递归死循环

**Gotchas**
- POST /auth/refresh 返回字段名 accessToken 不是 token — 前端更新 localStorage 时需匹配
- 11 files use raw fetch via utils/api.ts — 不经过 axios interceptor，认证需自行处理
- logout 时需同时清空 localStorage auth-storage 防止残留 token
