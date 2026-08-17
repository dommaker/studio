---
id: "sdd-1782806674857-xvud1a"
slug: "jwt-auth-system-oauth2-0"
title: "JWT 用户认证系统 + OAuth2.0 第三方登录"
status: "done"
tier: "premium"
version: 6
requirementVersion: 1
designVersion: 6
taskVersion: 1
parentId: "sdd-1782574335950-et11mn"
changeType: "L3"
createdAt: "2026-06-18T07:51:48.556Z"
updatedAt: "2026-06-30T08:04:34.857Z"
---

## Design

### ac-jwt-core

**Implementation Notes**
JWT 签发使用 jsonwebtoken 库，payload 固定 { sid: sessionId, uid?: userId }。密码哈希使用 bcryptjs (cost=10)，同时兼容旧 PBKDF2 salt:hash 格式——旧格式验证通过后标记 needsRehash，在 login 流程中自动升级为 bcrypt 存储。JWT_SECRET 生产环境必须设环境变量，dev 模式有默认值但明文硬编码仅用于开发。

**Architecture Context**
- Functions: generateToken(sessionId: string, userId?: string): string @ service.ts:75-77, verifyToken(token: string): { sessionId: string; userId?: string } | null @ service.ts:82-92, hashPassword(password: string): string @ service.ts:47-49, verifyPassword(password: string, storedHash: string): { valid: boolean; needsRehash: boolean } @ service.ts:56-70
- Call Chain: auth/routes.ts:requireAuth → middleware/auth.ts:requireAuth → auth/service.ts:verifyToken → jsonwebtoken.verify → prisma.session.findUnique
- Imports: import jwt from 'jsonwebtoken', import bcrypt from 'bcryptjs', import { prisma } from '@dommaker/studio-prisma'
- Danger Zones: service.ts:L13 — JWT_SECRET: 生产环境未设则直接 throw Error (启动阻断), dev 有默认值但明文硬编码不安全, service.ts:L56-L70 — verifyPassword: PBKDF2 旧格式兼容逻辑, 删除前需确认 DB 中无旧格式 hash 残留
- Verified At: apps/api/src/modules/auth/__tests__/service.test.ts:434 行

**Code Patterns**
- 密码旧格式兼容与静默升级: verifyPassword 同时支持 bcrypt 和旧 PBKDF2 salt:hash 格式, 旧格式验证通过后触发 needsRehash 标记 → login 流程中自动升级

**Gotchas**
- 不可删除 JWT payload 字段 { sid, uid } — 下游 consumer: middleware/auth.ts L113-126 用 payload.sessionId 查 session, 前端无解析 (透传)
- 不可修改 JWT_EXPIRES_IN_SECONDS = 7*24*60*60 不告知 — 前端无 JWT payload 解析 (所有判断靠 /auth/me 端点), RefreshToken 过期 30 天, 两者需协调

### ac-session

**Implementation Notes**
Guest session 使用 UUID 生成 token，getOrCreateSession 按 IP+UA+guestId 查找复用。登录时自动迁移 Guest→User：清理所有有效 guest session 后创建 user session。cleanupExpiredSessions 扫描 expiresAt < now() 的记录并批量删除。

**Architecture Context**
- Functions: createGuestSession(input: SessionInput): Promise<AuthResult> @ service.ts:97-122, getOrCreateSession(input: SessionInput): Promise<AuthResult> @ service.ts:127-146, login(input: LoginInput): Promise<AuthResult> @ service.ts:151-217, logout(sessionId: string, userId?: string): Promise<void> @ service.ts:275-287, getCurrentUser(sessionId: string): Promise<{ user: User | null; session: Session | null }> @ service.ts:292-306, cleanupExpiredSessions(): Promise<number> @ service.ts:311-319
- Call Chain: route-registry.ts:buildRouteTable → auth/routes.ts:default → auth/service.ts (login/register/refresh/guest-session/getCurrentUser/logout)
- Imports: import { prisma } from '@dommaker/studio-prisma', import jwt from 'jsonwebtoken'
- Danger Zones: N/A
- Verified At: apps/api/src/modules/auth/__tests__/service.test.ts:434 行, apps/api/tests/auth-flow.e2e.test.ts:147 行

**Code Patterns**
- Guest → User 会话迁移: 用户 login 后自动清理其所有有效 guest session (session.findMany + deleteMany), 后续请求用新 user session

### ac-auth-endpoints

**Implementation Notes**
7 个端点挂在 /api/v1/auth 路径下（route-registry.ts L164-165），部分端点套用 authRateLimit(10/min) 中间件。register 流程：email 查重 → bcrypt 哈希 → 创建 user(role='User') → 创建 session → 返回 AuthResult。login 流程：email 查用户 → verifyPassword → 清理 guest sessions → 创建 session + refresh token → 返回 AuthResult。

**Architecture Context**
- Functions: login(input: LoginInput): Promise<AuthResult> @ service.ts:151-217, register(input: RegisterInput): Promise<AuthResult> @ service.ts:222-268, logout(sessionId: string, userId?: string): Promise<void> @ service.ts:275-287, getCurrentUser(sessionId: string): Promise<{ user: User | null; session: Session | null }> @ service.ts:292-306, createGuestSession(input: SessionInput): Promise<AuthResult> @ service.ts:97-122
- Call Chain: route-registry.ts:buildRouteTable → auth/routes.ts:default → auth/service.ts (login/register/refresh/guest-session/getCurrentUser/logout)
- Imports: import { requireAuth, getAuthInfo, optionalAuth, requireRole } from '../../middleware/auth.js', import { authRateLimit, refreshRateLimit } from '../../middleware/rate-limit.js', import { AuditService } from '@dommaker/studio-audit'
- Danger Zones: schema.prisma:L423 — User.role 默认值 'Guest', 若新注册用户未显式设 role 则自动 Guest (但 register 中 hardcode 了 'User'), route-registry.ts:L164-165 — authRoutes + oauthRoutes 都挂载在 /api/v1/auth 下, 新增端点注意不要路径冲突
- Verified At: apps/api/src/modules/auth/__tests__/service.test.ts:434 行, apps/api/tests/auth-flow.e2e.test.ts:147 行

**Gotchas**
- 不可删除 AuthResult 的 refreshToken 字段 — 下游: frontend authStore.ts L134/158 存 refreshToken, web/api/index.ts L98-108 用 refreshToken 做 401 自动刷新

### ac-refresh-token

**Implementation Notes**
Refresh token 30 天有效期，持久化在 RefreshToken 表。exchangeRefreshToken 为 rotation 模式：吊销旧 token(set revokedAt) → 创建新 session → 生成新 access token + 新 refresh token。注意：此操作非事务包裹，并发场景可能重复消费。前端 axios interceptor 侦测 401 → 用独立 axios 实例发 refresh 请求 → 更新 store → retry 原请求。并发请求排队：isRefreshing 标志 + 请求队列。

**Architecture Context**
- Functions: generateRefreshToken(userId: string): Promise<string> @ service.ts:326-336, exchangeRefreshToken(refreshToken: string): Promise<{ accessToken; refreshToken; userId } | null> @ service.ts:341-372, revokeRefreshToken(refreshToken: string): Promise<boolean> @ service.ts:377-392
- Call Chain: web/api/index.ts:api.interceptors.response (401 catch) → refreshToken() → POST /auth/refresh → service.ts:exchangeRefreshToken
- Imports: import { generateRefreshToken, JWT_SECRET } from './service.js', import { prisma } from '@dommaker/studio-prisma'
- Danger Zones: service.ts:L341-L372 — exchangeRefreshToken: 同时吊销旧 token + 创建新 session + 新 refresh token, 非事务包裹 (并发场景可能重复消费)
- Verified At: apps/api/src/modules/auth/__tests__/service.test.ts:434 行

**Code Patterns**
- Refresh Token 轮换 (Rotation): exchangeRefreshToken 吊销旧 token → 创建新 access token + 新 refresh token。前端 axios interceptor 401 → refresh → retry + 并发队列。前端用独立 axios 实例避免 interceptor 递归

### ac-oauth

**Implementation Notes**
OAuth2 原生实现，不依赖 passport.js。用 native fetch 做 code exchange。CSRF 防护：httpOnly cookie 存随机 state，回调时先验证 state 再 clear cookie（L57 注意：cookie 先 clear 后比较，若 clear 失败则比较始终为 true）。token 通过 URL fragment (#) 传回前端避免 Referer 泄漏。getOrCreateOAuthUser 策略：① 按 provider+providerAccountId 查 OAuthAccount → ② email 匹配现有 User → 链接 → ③ 创建新 User + OAuthAccount。

**Architecture Context**
- Functions: getAuthorizationUrl(provider: OAuthProvider, state: string): string @ oauth.service.ts:31-63, exchangeCodeForTokens(provider: OAuthProvider, code: string): Promise<{ profile; tokens }> @ oauth.service.ts:68-80, getOrCreateOAuthUser(provider: OAuthProvider, profile: OAuthProfile, tokens: OAuthTokens): Promise<{ user }> @ oauth.service.ts:232-311, createOAuthSession(userId: string, req): Promise<{ token; refreshToken; session }> @ oauth.service.ts:316-353
- Call Chain: route-registry.ts:buildRouteTable → auth/oauth.routes.ts:default → auth/oauth.service.ts (getAuthorizationUrl/exchangeCodeForTokens/getOrCreateOAuthUser/createOAuthSession)
- Imports: import { prisma } from '@dommaker/studio-prisma', import { generateRefreshToken, JWT_SECRET } from './service.js'
- Danger Zones: oauth.routes.ts:L57 — CSRF state 验证: cookie 被 clear 后才比较, 若 clearCookie 失败则比较永远为 true (宽松但非漏洞因 cookie 未清除会继续匹配)
- Verified At: apps/api/src/modules/auth/__tests__/oauth.service.test.ts:258 行

**Code Patterns**
- OAuth2 原生实现 (无 passport.js): 用 native fetch 做 code exchange, URL 拼 authorization url。CSRF 用 httpOnly cookie 存 state。token 通过 URL fragment (#) 传回前端避免 Referer 泄漏

**Gotchas**
- 不可删除 oauth.routes.ts 的 state cookie CSRF 检查 (L57) — 安全漏洞: 攻击者可构造回调 URL 绑定攻击者账户到受害者邮箱

### ac-middleware

**Implementation Notes**
中间件工厂模式：requireAuth()/optionalAuth()/requireRole() 均返回 (req, res, next) => void 闭包，在 route-registry 中用 middleware: [requireAuth()] 数组挂载。optionalAuth 无 token 时调用 generateAnonymousId(IP+UA+date 哈希) 生成匿名标识用于审计追踪。requireAuth 注入 req.user/req.session 到下游 handler。workspaceAuth 验证 workspace token 并注入 req.workspace。

**Architecture Context**
- Functions: requireAuth(): (req, res, next) => void @ middleware/auth.ts:146-206, optionalAuth(): (req, res, next) => void @ middleware/auth.ts:97-138, requireRole(...roles: string[]): (req, res, next) => void @ middleware/auth.ts:211-242, checkOwnership(model: string, paramKey?: string): (req, res, next) => void @ middleware/auth.ts:247-303, requireNotGuest(): (req, res, next) => void @ middleware/auth.ts:308-321, workspaceAuth(): (req, res, next) => void @ middleware/auth.ts:328-383
- Call Chain: middleware/auth.ts:optionalAuth → auth/service.ts:verifyToken → prisma.session.findUnique (no token → generateAnonymousId 降级路径)
- Imports: import { verifyToken } from '../modules/auth/service.js', import { User, Session, Workspace, WorkspaceToken } from '@prisma/client'
- Danger Zones: middleware/auth.ts:L41-L48 — getAuthInfo() 返回的 sessionId 为空字符串兜底, 下游消费方可能未判断空值
- Verified At: apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts:164 行

**Code Patterns**
- 中间件工厂模式: requireAuth()/optionalAuth()/requireRole() 均返回 (req, res, next) => void 闭包, 在 route-registry 中用 middleware: [requireAuth()] 数组挂载

**Gotchas**
- 不可删除 middleware/auth.ts 中 generateAnonymousId (L56-62) — SEC-009: 匿名审计标识, 下游用于 audit log 无用户追踪。修改 hash 算法会破坏匿名 ID 一致性 (IP+UA+date 不变则 ID 不变)

### ac-rate-limit

**Implementation Notes**
基于 express-rate-limit 中间件实现。authRateLimit 应用于登录/注册端点（windowMs=60s, max=10），refreshRateLimit 应用于 refresh 端点（windowMs=60s, max=20）。均为 IP 级别限流。

**Architecture Context**
- Functions: authRateLimit — 10 req/min/IP (express-rate-limit middleware), refreshRateLimit — 20 req/min/IP (express-rate-limit middleware)
- Call Chain: auth/routes.ts 端点 handler 数组 → authRateLimit/refreshRateLimit 中间件 → handler
- Imports: import rateLimit from 'express-rate-limit', import { authRateLimit, refreshRateLimit } from '../../middleware/rate-limit.js'
- Danger Zones: N/A
- Verified At: 集成在 auth endpoint 测试中

**Gotchas**
- 不可修改 rate-limit.ts authRateLimit 的 10/min 上限 — 暴力破解防护阈值, 需安全评审才能放松