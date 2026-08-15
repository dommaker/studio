---
id: "sdd-1783073945477-0eb61u"
slug: "jwt-auth-system-token-refresh-oauth2-0-xxxx"
title: "JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录"
status: "done"
version: 6
designVersion: 6
parentId: "sdd-1782982502274-mbmseo"
changeType: "L3"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "security", "DONE"]
createdAt: "2026-06-10T02:18:56.354Z"
updatedAt: "2026-07-03T10:19:05.477Z"
---

# JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录

基于JWT的用户认证系统，支持token自动刷新和Google/GitHub OAuth2.0第三方登录——已完整实现，本文档为完成状态归档

<!-- TASK_TIER {"tier":"fast","reason":"核心功能已全部实现（42/42测试通过），无新代码需编写。本文档归档现有实现状态并记录发现的边界缺口。"} -->

## Architecture Context

### core-jwt-auth

**Functions**
- hashPassword(password: string): string @ L47
- verifyPassword(password: string, storedHash: string): { valid: boolean; needsRehash: boolean } @ L56
- generateToken(sessionId: string, userId?: string): string @ L75
- verifyToken(token: string): { sessionId: string; userId?: string } | null @ L82
- createGuestSession(input: SessionInput): Promise<AuthResult> @ L97
- getOrCreateSession(input: SessionInput): Promise<AuthResult> @ L127
- login(input: LoginInput): Promise<AuthResult> @ L151
- register(input: RegisterInput): Promise<AuthResult> @ L222
- logout(sessionId: string, userId?: string): Promise<void> @ L275
- getCurrentUser(sessionId: string): Promise<{user, session}> @ L292
- cleanupExpiredSessions(): Promise<number> @ L311

**Call Chain**
routes.ts handler → service.ts function → Prisma DB

**Imports**
- import { prisma } from '@studio/prisma'
- import jwt from 'jsonwebtoken'
- import bcrypt from 'bcryptjs'

**Types in Scope**
- SessionInput { ipAddress?: string; userAgent?: string }
- LoginInput { email: string; password: string; ipAddress?: string; userAgent?: string }
- RegisterInput { email: string; password: string; name?: string }
- AuthResult { token: string; user: User; session: Session; refreshToken?: string; isNewUser?: boolean }

**Test Mocks**
- vi.mock('@studio/prisma', () => ({ prisma: { session: { create/findUnique/update/deleteMany }, user: { findUnique/create/update }, refreshToken: { create/findFirst/updateMany/update/delete } } }))

**Danger Zones**
- verifyPassword 双格式支持——不要删除 legacy PBKDF2 分支（已有用户的密码哈希是旧格式）
- AuthResult 结构——authStore 和 Axios interceptor 依赖 token/user/session 字段名

### refresh-token

**Functions**
- generateRefreshToken(userId: string): Promise<string> @ L326
- exchangeRefreshToken(refreshToken: string): Promise<{accessToken, refreshToken, userId} | null> @ L341
- revokeRefreshToken(refreshToken: string): Promise<boolean> @ L377

**Call Chain**
POST /auth/refresh → routes.ts handler → exchangeRefreshToken() → prisma.refreshToken.updateMany + create

**Imports**
- import { prisma } from '@studio/prisma'
- import crypto from 'crypto'

**Test Mocks**
- vi.mock('@studio/prisma')

**Danger Zones**
- exchangeRefreshToken 每次创建新 session——旧 session 不会被清理（依赖 cleanupExpiredSessions）

### oauth2-google-github

**Functions**
- getAuthorizationUrl(provider: 'google'|'github', state: string): string @ L31
- exchangeCodeForTokens(provider, code): Promise<{profile: OAuthProfile; tokens: OAuthTokens}> @ L68
- getOrCreateOAuthUser(provider, profile, tokens): Promise<{user}> @ L232
- createOAuthSession(userId: string, req: Request): Promise<{token, refreshToken, session}> @ L316

**Call Chain**
GET /auth/:provider → redirect to provider → GET /auth/callback/:provider → exchangeCodeForTokens → getOrCreateOAuthUser → createOAuthSession → redirect to frontend with #token=&refreshToken=&sessionId=

**Imports**
- import { prisma } from '@studio/prisma'
- import { generateToken, generateRefreshToken } from './service'

**Types in Scope**
- OAuthProfile { id: string; email: string; name?: string; avatar?: string }
- OAuthTokens { accessToken: string; refreshToken?: string; expiresAt?: Date }

**Test Mocks**
- vi.mock('@studio/prisma')
- vi.mock('./service', () => ({ generateToken: vi.fn().mockReturnValue('mock-jwt'), generateRefreshToken: vi.fn().mockResolvedValue('mock-refresh') }))

**Danger Zones**
- getOrCreateOAuthUser 的 3 条路径——不要合并或删除任一分支
- GitHub email fallback (L150-L180)——当 primary email 未公开时查询 /user/emails

### oauth-routes-csrf

**Functions**
- GET /auth/:provider(google|github) @ L18 — 生成 state + cookie + redirect
- GET /auth/callback/:provider @ L43 — 验证 state + exchange + session + redirect

**Call Chain**
浏览器 → GET /auth/google → redirect to accounts.google.com → GET /auth/callback/google → exchangeCodeForTokens → getOrCreateOAuthUser → createOAuthSession → redirect to frontend

**Imports**
- import { Router } from 'express'
- import crypto from 'crypto'
- import { getAuthorizationUrl, exchangeCodeForTokens, getOrCreateOAuthUser, createOAuthSession } from './oauth.service'

**Danger Zones**
- L23-L28 CSRF state cookie 设置——不要改 SameSite 或 httpOnly 属性
- L81 URL fragment 格式 #token=... 不要改成 query params（安全设计决策）

### frontend-auth-integration

**Functions**
- Request interceptor @ api/index.ts:L35 — localStorage token → Bearer header
- Response interceptor @ api/index.ts:L70 — 401 catch → refresh queue → retry
- OAuthCallback component @ OAuthCallback.tsx — hash parse → setToken → checkAuth → navigate
- authStore.setToken @ authStore.ts — 更新 token + refreshToken state
- authStore.checkAuth @ authStore.ts — GET /auth/me → 更新 user state

**Call Chain**
API request → request interceptor (Bearer) → server → 401? → response interceptor → POST /auth/refresh → retry

**Imports**
- import axios from 'axios'
- import { useAuthStore } from '../stores/authStore'

**Danger Zones**
- api/index.ts L13-L14 注释：不导入 authStore 避免循环依赖——直接读 localStorage
- AUTH_PATHS 列表——不要添加新路径（会跳过 401 刷新）

### auth-middleware

**Functions**
- requireAuth() @ L146 — factory, returns async (req, res, next)
- optionalAuth() @ L97 — same but calls next() without token
- requireRole(...roles) @ L211 — 403 if role not in roles
- getAuthInfo(req) @ L41 — extracts {sessionId, userId, anonymousId}
- checkOwnership(model, paramKey) @ L247 — admin bypass + creatorId check

**Call Chain**
route-registry.ts → requireAuth() → middleware → req.authReq = {user, session, anonymousId}

**Imports**
- import { verifyToken } from '../modules/auth/service'
- import { prisma } from '@studio/prisma'

**Types in Scope**
- AuthRequest extends Request { authReq?: { user: User; session: Session; anonymousId: string } }

**Test Mocks**
- vi.mock('../modules/auth/service', () => ({ verifyToken: vi.fn() }))
- vi.mock('@studio/prisma')

**Danger Zones**
- L146 requireAuth 是工厂函数——调用时必须 requireAuth() 带括号
- L178 session 过期检查——不要跳过 expiresAt 比较

### prisma-schema

**Call Chain**
schema.prisma → prisma generate → TypeScript types → service.ts / oauth.service.ts

**Types in Scope**
- User { id, email, passwordHash?, name?, avatar?, role, createdAt, updatedAt }
- Session { id, userId?, token, guestId?, ipAddress?, userAgent?, expiresAt, createdAt }
- RefreshToken { id, token, userId, expiresAt, createdAt, revokedAt? }
- OAuthAccount { id, userId, provider, providerAccountId, accessToken?, refreshToken?, expiresAt?, profile?, createdAt, updatedAt }

**Danger Zones**
- User.role 默认 Guest——新注册用户默认为 Guest
- OAuthAccount @@unique[provider, providerAccountId]——不要删除

### security-hardening

**Functions**
- logout(sessionId: string, userId?: string): Promise<void> @ L275 — 扩展：userId 存在时 revoke all refresh tokens
- login(input: LoginInput): Promise<AuthResult> @ L151 — 扩展：登录时 cleanup expired guest sessions

**Call Chain**
POST /auth/logout → requireAuth → logout(sessionId, userId) → revokeAllRefreshTokensForUser

**Danger Zones**
- logout 签名扩展必须向后兼容——userId 可选

## AC Groups

### core-jwt-auth

#### 实现指南
已完成。service.ts 包含全部核心认证函数。16 个测试覆盖 guest session、login、register、verifyToken、getCurrentUser、logout、refresh tokens。

#### 参考模式
- 参考 service.ts:L47-L56 bcrypt 实现
- 参考 service.ts:L75-L90 JWT 实现

#### ⚠️ 注意事项
- ⚠️ AuthResult.refreshToken 是可选字段——authStore 需处理 undefined
- ⚠️ logout 签名扩展为 (sessionId, userId?) 后向兼容

### refresh-token

#### 实现指南
已完成。exchangeRefreshToken 使用 revoke-then-create 策略实现 token 旋转。7 个测试覆盖 generate/exchange(revoked/expired/nonexistent/valid)/revoke。

#### 参考模式
- 参考 service.ts:L341-L375 revoke-then-create 模式

#### ⚠️ 注意事项
- ⚠️ refresh 端点无速率限制——暴力破解风险

### oauth2-google-github

#### 实现指南
已完成。10 个测试覆盖 getAuthorizationUrl(5)、exchangeCodeForTokens(1)、getOrCreateOAuthUser(4)、createOAuthSession(1)、redirect URL fragment(2)。

#### 参考模式
- 参考 oauth.service.ts:L232-L315 三路径用户查找/创建模式

#### ⚠️ 注意事项
- ⚠️ OAuthAccount.refreshToken 存储在 DB 但从未用于刷新 provider token——过期后需用户重新授权

### oauth-routes-csrf

#### 实现指南
已完成。无独立测试文件（gap）。CSRF 通过 httpOnly cookie 实现，token 通过 URL fragment 防止 Referer 泄漏。

#### 参考模式
- 参考 oauth.routes.ts:L23-L28 cookie 设置模式

#### ⚠️ 注意事项
- ⚠️ oauth.routes.ts 无测试文件——gap

### frontend-auth-integration

#### 实现指南
已完成。Axios 拦截器实现 Bearer 自动注入 + 401 刷新重试队列。authStore 使用 Zustand persist 持久化到 localStorage。OAuthCallback 解析 URL fragment。

#### 参考模式
- 参考 api/index.ts:L70-L120 401 刷新队列模式

#### ⚠️ 注意事项
- ⚠️ authStore 有死代码 getAuthHeader()（wa3f 发现，未清理）

### auth-middleware

#### 实现指南
已完成。6 个测试覆盖 requireAuth(3)、requireRole(2)、optionalAuth(3)。requireAuth 工厂在 route-registry.ts:158 调用。

#### 参考模式
- 参考 middleware/auth.ts:L146-L210 requireAuth 工厂模式

#### ⚠️ 注意事项
- ⚠️ requireAuth() 必须作为工厂调用——不带括号传入 route 会把 middleware 实例当 handler

### prisma-schema

#### 实现指南
已完成。4 个模型定义完整，关系配置正确（cascade delete）。Lurk Wall 白名单包含所有公开 auth 端点。

#### ⚠️ 注意事项
- ⚠️ dead /auth/session 条目已从 PUBLIC_API 移除（wa3f AC3）

### security-hardening

#### 实现指南
已完成（wa3f spec）。42/42 测试通过。logout 签名扩展、cleanup admin guard、dead entry 移除、guest session cleanup on login。