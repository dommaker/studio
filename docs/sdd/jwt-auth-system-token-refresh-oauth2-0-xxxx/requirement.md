---
id: "cmq7fwr1h008713h6y1slspfo"
slug: "jwt-auth-system-token-refresh-oauth2-0-xxxx"
title: "JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "security", "DONE"]
createdAt: "2026-06-10T02:18:56.354Z"
updatedAt: "2026-06-10T02:18:56.354Z"
---

# JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录

基于JWT的用户认证系统，支持token自动刷新和Google/GitHub OAuth2.0第三方登录——已完整实现，本文档为完成状态归档

<!-- TASK_TIER {"tier":"fast","reason":"核心功能已全部实现（42/42测试通过），无新代码需编写。本文档归档现有实现状态并记录发现的边界缺口。"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["JWT generateToken/verifyToken — service.ts:L75/L82, payload {sid, uid}","Refresh token generate/exchange/revoke — service.ts:L326/L341/L377","OAuth getAuthorizationUrl — oauth.service.ts:L31, providers: google|github","OAuth exchangeCodeForTokens — oauth.service.ts:L68","OAuth getOrCreateOAuthUser — oauth.service.ts:L232 (3 paths: existing OAuth, existing email, new user)","OAuth createOAuthSession — oauth.service.ts:L316","POST /auth/guest-session — routes.ts:L15","POST /auth/register — routes.ts:L33","POST /auth/login — routes.ts:L73","POST /auth/logout — routes.ts:L121 (requireAuth)","GET /auth/me — routes.ts:L146 (optionalAuth)","POST /auth/refresh — routes.ts:L177 (public)","POST /auth/cleanup — routes.ts:L164 (requireAuth + requireRole Admin)","GET /auth/:provider — oauth.routes.ts:L18 (CSRF state cookie)","GET /auth/callback/:provider — oauth.routes.ts:L43 (URL fragment redirect)","requireAuth() middleware — middleware/auth.ts:L146","optionalAuth() middleware — middleware/auth.ts:L97","requireRole() middleware — middleware/auth.ts:L211","Axios request interceptor (Bearer injection) — api/index.ts:L35","Axios response interceptor (401 refresh+retry) — api/index.ts:L70","authStore (Zustand persist) — authStore.ts, localStorage key: auth-storage","OAuthCallback component — OAuthCallback.tsx, parses window.location.hash","AuthModal component — AuthModal.tsx, Google/GitHub OAuth buttons","Prisma models: User, Session, RefreshToken, OAuthAccount — schema.prisma:L416-L481"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ JWT generateToken/verifyToken — service.ts:L75/L82, payload {sid, uid}
- ✅ Refresh token generate/exchange/revoke — service.ts:L326/L341/L377
- ✅ OAuth getAuthorizationUrl — oauth.service.ts:L31, providers: google|github
- ✅ OAuth exchangeCodeForTokens — oauth.service.ts:L68
- ✅ OAuth getOrCreateOAuthUser — oauth.service.ts:L232 (3 paths: existing OAuth, existing email, new user)
- ✅ OAuth createOAuthSession — oauth.service.ts:L316
- ✅ POST /auth/guest-session — routes.ts:L15
- ✅ POST /auth/register — routes.ts:L33
- ✅ POST /auth/login — routes.ts:L73
- ✅ POST /auth/logout — routes.ts:L121 (requireAuth)
- ✅ GET /auth/me — routes.ts:L146 (optionalAuth)
- ✅ POST /auth/refresh — routes.ts:L177 (public)
- ✅ POST /auth/cleanup — routes.ts:L164 (requireAuth + requireRole Admin)
- ✅ GET /auth/:provider — oauth.routes.ts:L18 (CSRF state cookie)
- ✅ GET /auth/callback/:provider — oauth.routes.ts:L43 (URL fragment redirect)
- ✅ requireAuth() middleware — middleware/auth.ts:L146
- ✅ optionalAuth() middleware — middleware/auth.ts:L97
- ✅ requireRole() middleware — middleware/auth.ts:L211
- ✅ Axios request interceptor (Bearer injection) — api/index.ts:L35
- ✅ Axios response interceptor (401 refresh+retry) — api/index.ts:L70
- ✅ authStore (Zustand persist) — authStore.ts, localStorage key: auth-storage
- ✅ OAuthCallback component — OAuthCallback.tsx, parses window.location.hash
- ✅ AuthModal component — AuthModal.tsx, Google/GitHub OAuth buttons
- ✅ Prisma models: User, Session, RefreshToken, OAuthAccount — schema.prisma:L416-L481

## AC Groups

### core-jwt-auth
<!-- MODEL_TIER {"tier":"fast","reason":"已完成，无新代码"} -->

#### 验收标准
- [ ] AC1: 在 service.ts L47-L56；使用 bcrypt cost 12 实现 hashPassword/verifyPassword，支持 legacy PBKDF2 格式自动升级；不删除 verifyPassword 的 needsRehash 返回字段
- [ ] AC2: 在 service.ts L75-L90；使用 jsonwebtoken 生成 JWT（payload: {sid, uid}，7天过期），verifyToken 返回 {sessionId, userId} | null；不修改 payload 结构（下游 authStore 和中间件依赖）
- [ ] AC3: 在 service.ts L97-L145；实现 createGuestSession（24h过期）和 getOrCreateSession；不修改 SessionInput 接口
- [ ] AC4: 在 service.ts L151-L270；实现 login（guest cleanup + PBKDF2 rehash）和 register（返回 isNewUser）；错误消息保持中文（用户已适配）
- [ ] AC5: 在 service.ts L275-L320；实现 logout（expire session + revoke refresh tokens when userId）和 getCurrentUser；不修改 AuthResult 返回结构

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/__tests__/service.test.ts

### refresh-token
<!-- MODEL_TIER {"tier":"fast","reason":"已完成，无新代码"} -->

#### 验收标准
- [ ] AC1: 在 service.ts L326-L390；实现 generateRefreshToken（30天过期）、exchangeRefreshToken（revoke-then-create 旋转）、revokeRefreshToken；不修改 RefreshToken Prisma 模型
- [ ] AC2: 在 routes.ts L177-L200；POST /auth/refresh 端点为公开路由（无需认证），调用 exchangeRefreshToken 返回新 accessToken + refreshToken；不添加 requireAuth 中间件

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/routes.ts
- apps/api/src/modules/auth/__tests__/service.test.ts

#### 依赖: core-jwt-auth

### oauth2-google-github
<!-- MODEL_TIER {"tier":"fast","reason":"已完成，无新代码"} -->

#### 验收标准
- [ ] AC1: 在 oauth.service.ts L31-L65；实现 getAuthorizationUrl 支持 google（scope: openid email profile）和 github（scope: user:email），返回授权 URL；不添加新 provider
- [ ] AC2: 在 oauth.service.ts L68-L230；实现 exchangeCodeForTokens 支持 google 和 github，处理 github /user/emails fallback；不修改 OAuthProfile 接口
- [ ] AC3: 在 oauth.service.ts L232-L315；实现 getOrCreateOAuthUser 处理 3 条路径（existing OAuth account / existing email user / new user），使用 @@unique[provider, providerAccountId]；不删除 upsert 逻辑
- [ ] AC4: 在 oauth.service.ts L316-L350；实现 createOAuthSession 返回 {token, refreshToken, session}，JWT payload 与 service.ts 一致 {sid, uid}；不修改 token 生成逻辑

#### 涉及文件
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts

#### 依赖: core-jwt-auth

### oauth-routes-csrf
<!-- MODEL_TIER {"tier":"fast","reason":"已完成，无新代码"} -->

#### 验收标准
- [ ] AC1: 在 oauth.routes.ts L18-L40；GET /auth/:provider 生成随机 state，存入 httpOnly cookie（oauth_state, SameSite=Lax），重定向到 provider 授权页；不修改 cookie 名称（前端不依赖，但测试断言它）
- [ ] AC2: 在 oauth.routes.ts L43-L100；GET /auth/callback/:provider 验证 CSRF state（cookie vs query），交换 code，创建 session，用 URL fragment（#token=...&refreshToken=...&sessionId=）重定向到前端；错误用 query params 传递

#### 涉及文件
- apps/api/src/modules/auth/oauth.routes.ts

#### 依赖: oauth2-google-github

### frontend-auth-integration
<!-- MODEL_TIER {"tier":"fast","reason":"已完成，无新代码"} -->

#### 验收标准
- [ ] AC1: 在 api/index.ts L35-L65；请求拦截器从 localStorage（auth-storage）读取 token，注入 Authorization: Bearer header；不导入 authStore（避免循环依赖）
- [ ] AC2: 在 api/index.ts L70-L120；响应拦截器捕获 401，跳过 AUTH_PATHS，使用队列防并发刷新，调用 POST /auth/refresh 更新 localStorage 并重试原请求；不修改 AUTH_PATHS 列表
- [ ] AC3: 在 OAuthCallback.tsx；解析 window.location.hash 获取 token/refreshToken，调用 setToken + checkAuth，导航到 /channels；错误从 query params 读取并重定向到 /
- [ ] AC4: 在 authStore.ts；Zustand store + persist middleware（localStorage key: auth-storage），包含 init/createGuestSession/checkAuth/login/register/logout/setToken/fetchMe actions；不修改 persist 配置

#### 涉及文件
- apps/web/src/api/index.ts
- apps/web/src/components/OAuthCallback.tsx
- apps/web/src/components/AuthModal.tsx
- apps/web/src/stores/authStore.ts

#### 依赖: core-jwt-auth, oauth-routes-csrf

### auth-middleware
<!-- MODEL_TIER {"tier":"fast","reason":"已完成，无新代码"} -->

#### 验收标准
- [ ] AC1: 在 middleware/auth.ts L146-L210；requireAuth() 工厂函数返回 async middleware，验证 JWT、查找 session、附加 user/session/anonymousId 到 req；无效/过期 token 返回 401
- [ ] AC2: 在 middleware/auth.ts L97-L145；optionalAuth() 同 requireAuth 但无 token 时调用 next()，始终生成 anonymousId
- [ ] AC3: 在 middleware/auth.ts L211-L245；requireRole(...roles) 检查 session.userId 存在且 user.role 在 roles 中，否则 403

#### 涉及文件
- apps/api/src/middleware/auth.ts
- apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts

#### 依赖: core-jwt-auth

### prisma-schema
<!-- MODEL_TIER {"tier":"fast","reason":"已完成，无新代码"} -->

#### 验收标准
- [ ] AC1: 在 schema.prisma L416-L481；定义 User（email unique, role default Guest）、Session（token unique, indexed userId/token/expiresAt）、RefreshToken（token unique, revokedAt?）、OAuthAccount（@@unique[provider, providerAccountId]）模型，配置级联删除关系
- [ ] AC2: 在 app.ts L78-L107；Lurk Wall PUBLIC_API 白名单包含所有 auth 路由（/auth/guest-session, /auth/register, /auth/login, /auth/github, /auth/callback/github）；生产环境生效

#### 涉及文件
- packages/studio-prisma/prisma/schema.prisma
- apps/api/src/app.ts

### security-hardening
<!-- MODEL_TIER {"tier":"fast","reason":"已完成，无新代码"} -->

#### 验收标准
- [ ] AC1: 在 service.ts logout()；当 userId 存在时撤销该用户所有 refresh tokens（revokeAllRefreshTokensForUser），向后兼容签名扩展
- [ ] AC2: 在 routes.ts /cleanup 端点；添加 requireAuth() + requireRole('Admin') 中间件保护
- [ ] AC3: 在 app.ts PUBLIC_API Set；移除死条目 /auth/session（无对应端点）
- [ ] AC4: 在 service.ts login()；登录时删除该用户的过期 guest sessions
- [ ] AC5: 在 __tests__/service.test.ts；为 AC1-AC4 添加测试用例

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/routes.ts
- apps/api/src/app.ts
- apps/api/src/modules/auth/__tests__/service.test.ts

#### 依赖: core-jwt-auth, refresh-token
## 约束
- JWT payload 必须为 {sid, uid}——authStore、中间件、OAuth 服务均依赖此结构
- AuthResult 返回结构不可变——前端 authStore 和 Axios 拦截器依赖 token/user/session 字段
- OAuth token 通过 URL fragment（#）传递——安全设计决策，防止 Referer 泄漏
- AUTH_PATHS 列表中的路径会跳过 401 刷新——添加新 auth 路径时需同步更新
- Lurk Wall PUBLIC_API 仅在生产环境生效——开发环境所有路由公开

## AC Groups

```json
[
  {
    "id": "core-jwt-auth",
    "description": "JWT 生成/验证 + 密码哈希 + 会话管理（已完成）",
    "acs": [
      "AC1: 在 service.ts L47-L56；使用 bcrypt cost 12 实现 hashPassword/verifyPassword，支持 legacy PBKDF2 格式自动升级；不删除 verifyPassword 的 needsRehash 返回字段",
      "AC2: 在 service.ts L75-L90；使用 jsonwebtoken 生成 JWT（payload: {sid, uid}，7天过期），verifyToken 返回 {sessionId, userId} | null；不修改 payload 结构（下游 authStore 和中间件依赖）",
      "AC3: 在 service.ts L97-L145；实现 createGuestSession（24h过期）和 getOrCreateSession；不修改 SessionInput 接口",
      "AC4: 在 service.ts L151-L270；实现 login（guest cleanup + PBKDF2 rehash）和 register（返回 isNewUser）；错误消息保持中文（用户已适配）",
      "AC5: 在 service.ts L275-L320；实现 logout（expire session + revoke refresh tokens when userId）和 getCurrentUser；不修改 AuthResult 返回结构"
    ],
    "files": [
      "apps/api/src/modules/auth/service.ts",
      "apps/api/src/modules/auth/__tests__/service.test.ts"
    ],
    "dependencies": [],
    "implementationNotes": "已完成。service.ts 包含全部核心认证函数。16 个测试覆盖 guest session、login、register、verifyToken、getCurrentUser、logout、refresh tokens。",
    "architectureContext": {
      "functions": [
        "hashPassword(password: string): string @ L47",
        "verifyPassword(password: string, storedHash: string): { valid: boolean; needsRehash: boolean } @ L56",
        "generateToken(sessionId: string, userId?: string): string @ L75",
        "verifyToken(token: string): { sessionId: string; userId?: string } | null @ L82",
        "createGuestSession(input: SessionInput): Promise<AuthResult> @ L97",
        "getOrCreateSession(input: SessionInput): Promise<AuthResult> @ L127",
        "login(input: LoginInput): Promise<AuthResult> @ L151",
        "register(input: RegisterInput): Promise<AuthResult> @ L222",
        "logout(sessionId: string, userId?: string): Promise<void> @ L275",
        "getCurrentUser(sessionId: string): Promise<{user, session}> @ L292",
        "cleanupExpiredSessions(): Promise<number> @ L311"
      ],
      "callChain": "routes.ts handler → service.ts function → Prisma DB",
      "imports": [
        "import { prisma } from '@studio/prisma'",
        "import jwt from 'jsonwebtoken'",
        "import bcrypt from 'bcryptjs'"
      ],
      "typesInScope": [
        "SessionInput { ipAddress?: string; userAgent?: string }",
        "LoginInput { email: string; password: string; ipAddress?: string; userAgent?: string }",
        "RegisterInput { email: string; password: string; name?: string }",
        "AuthResult { token: string; user: User; session: Session; refreshToken?: string; isNewUser?: boolean }"
      ],
      "testMock": [
        "vi.mock('@studio/prisma', () => ({ prisma: { session: { create/findUnique/update/deleteMany }, user: { findUnique/create/update }, refreshToken: { create/findFirst/updateMany/update/delete } } }))"
      ],
      "dangerZones": [
        "verifyPassword 双格式支持——不要删除 legacy PBKDF2 分支（已有用户的密码哈希是旧格式）",
        "AuthResult 结构——authStore 和 Axios interceptor 依赖 token/user/session 字段名"
      ],
      "verifiedAt": "2026-06-09 (wa3f spec verified)"
    },
    "codePatterns": [
      "参考 service.ts:L47-L56 bcrypt 实现",
      "参考 service.ts:L75-L90 JWT 实现"
    ],
    "gotchas": [
      "⚠️ AuthResult.refreshToken 是可选字段——authStore 需处理 undefined",
      "⚠️ logout 签名扩展为 (sessionId, userId?) 后向兼容"
    ],
    "modelTier": "fast",
    "modelTierReason": "已完成，无新代码"
  },
  {
    "id": "refresh-token",
    "description": "Refresh Token 旋转机制（已完成）",
    "acs": [
      "AC1: 在 service.ts L326-L390；实现 generateRefreshToken（30天过期）、exchangeRefreshToken（revoke-then-create 旋转）、revokeRefreshToken；不修改 RefreshToken Prisma 模型",
      "AC2: 在 routes.ts L177-L200；POST /auth/refresh 端点为公开路由（无需认证），调用 exchangeRefreshToken 返回新 accessToken + refreshToken；不添加 requireAuth 中间件"
    ],
    "files": [
      "apps/api/src/modules/auth/service.ts",
      "apps/api/src/modules/auth/routes.ts",
      "apps/api/src/modules/auth/__tests__/service.test.ts"
    ],
    "dependencies": [
      "core-jwt-auth"
    ],
    "implementationNotes": "已完成。exchangeRefreshToken 使用 revoke-then-create 策略实现 token 旋转。7 个测试覆盖 generate/exchange(revoked/expired/nonexistent/valid)/revoke。",
    "architectureContext": {
      "functions": [
        "generateRefreshToken(userId: string): Promise<string> @ L326",
        "exchangeRefreshToken(refreshToken: string): Promise<{accessToken, refreshToken, userId} | null> @ L341",
        "revokeRefreshToken(refreshToken: string): Promise<boolean> @ L377"
      ],
      "callChain": "POST /auth/refresh → routes.ts handler → exchangeRefreshToken() → prisma.refreshToken.updateMany + create",
      "imports": [
        "import { prisma } from '@studio/prisma'",
        "import crypto from 'crypto'"
      ],
      "typesInScope": [],
      "testMock": [
        "vi.mock('@studio/prisma')"
      ],
      "dangerZones": [
        "exchangeRefreshToken 每次创建新 session——旧 session 不会被清理（依赖 cleanupExpiredSessions）"
      ],
      "verifiedAt": "2026-06-09 (wa3f spec verified)"
    },
    "codePatterns": [
      "参考 service.ts:L341-L375 revoke-then-create 模式"
    ],
    "gotchas": [
      "⚠️ refresh 端点无速率限制——暴力破解风险"
    ],
    "modelTier": "fast",
    "modelTierReason": "已完成，无新代码"
  },
  {
    "id": "oauth2-google-github",
    "description": "OAuth2.0 第三方登录（Google + GitHub）（已完成）",
    "acs": [
      "AC1: 在 oauth.service.ts L31-L65；实现 getAuthorizationUrl 支持 google（scope: openid email profile）和 github（scope: user:email），返回授权 URL；不添加新 provider",
      "AC2: 在 oauth.service.ts L68-L230；实现 exchangeCodeForTokens 支持 google 和 github，处理 github /user/emails fallback；不修改 OAuthProfile 接口",
      "AC3: 在 oauth.service.ts L232-L315；实现 getOrCreateOAuthUser 处理 3 条路径（existing OAuth account / existing email user / new user），使用 @@unique[provider, providerAccountId]；不删除 upsert 逻辑",
      "AC4: 在 oauth.service.ts L316-L350；实现 createOAuthSession 返回 {token, refreshToken, session}，JWT payload 与 service.ts 一致 {sid, uid}；不修改 token 生成逻辑"
    ],
    "files": [
      "apps/api/src/modules/auth/oauth.service.ts",
      "apps/api/src/modules/auth/__tests__/oauth.service.test.ts"
    ],
    "dependencies": [
      "core-jwt-auth"
    ],
    "implementationNotes": "已完成。10 个测试覆盖 getAuthorizationUrl(5)、exchangeCodeForTokens(1)、getOrCreateOAuthUser(4)、createOAuthSession(1)、redirect URL fragment(2)。",
    "architectureContext": {
      "functions": [
        "getAuthorizationUrl(provider: 'google'|'github', state: string): string @ L31",
        "exchangeCodeForTokens(provider, code): Promise<{profile: OAuthProfile; tokens: OAuthTokens}> @ L68",
        "getOrCreateOAuthUser(provider, profile, tokens): Promise<{user}> @ L232",
        "createOAuthSession(userId: string, req: Request): Promise<{token, refreshToken, session}> @ L316"
      ],
      "callChain": "GET /auth/:provider → redirect to provider → GET /auth/callback/:provider → exchangeCodeForTokens → getOrCreateOAuthUser → createOAuthSession → redirect to frontend with #token=&refreshToken=&sessionId=",
      "imports": [
        "import { prisma } from '@studio/prisma'",
        "import { generateToken, generateRefreshToken } from './service'"
      ],
      "typesInScope": [
        "OAuthProfile { id: string; email: string; name?: string; avatar?: string }",
        "OAuthTokens { accessToken: string; refreshToken?: string; expiresAt?: Date }"
      ],
      "testMock": [
        "vi.mock('@studio/prisma')",
        "vi.mock('./service', () => ({ generateToken: vi.fn().mockReturnValue('mock-jwt'), generateRefreshToken: vi.fn().mockResolvedValue('mock-refresh') }))"
      ],
      "dangerZones": [
        "getOrCreateOAuthUser 的 3 条路径——不要合并或删除任一分支",
        "GitHub email fallback (L150-L180)——当 primary email 未公开时查询 /user/emails"
      ],
      "verifiedAt": "2026-06-09 (wa3f spec verified)"
    },
    "codePatterns": [
      "参考 oauth.service.ts:L232-L315 三路径用户查找/创建模式"
    ],
    "gotchas": [
      "⚠️ OAuthAccount.refreshToken 存储在 DB 但从未用于刷新 provider token——过期后需用户重新授权"
    ],
    "modelTier": "fast",
    "modelTierReason": "已完成，无新代码"
  },
  {
    "id": "oauth-routes-csrf",
    "description": "OAuth 路由 + CSRF 防护（已完成）",
    "acs": [
      "AC1: 在 oauth.routes.ts L18-L40；GET /auth/:provider 生成随机 state，存入 httpOnly cookie（oauth_state, SameSite=Lax），重定向到 provider 授权页；不修改 cookie 名称（前端不依赖，但测试断言它）",
      "AC2: 在 oauth.routes.ts L43-L100；GET /auth/callback/:provider 验证 CSRF state（cookie vs query），交换 code，创建 session，用 URL fragment（#token=...&refreshToken=...&sessionId=）重定向到前端；错误用 query params 传递"
    ],
    "files": [
      "apps/api/src/modules/auth/oauth.routes.ts"
    ],
    "dependencies": [
      "oauth2-google-github"
    ],
    "implementationNotes": "已完成。无独立测试文件（gap）。CSRF 通过 httpOnly cookie 实现，token 通过 URL fragment 防止 Referer 泄漏。",
    "architectureContext": {
      "functions": [
        "GET /auth/:provider(google|github) @ L18 — 生成 state + cookie + redirect",
        "GET /auth/callback/:provider @ L43 — 验证 state + exchange + session + redirect"
      ],
      "callChain": "浏览器 → GET /auth/google → redirect to accounts.google.com → GET /auth/callback/google → exchangeCodeForTokens → getOrCreateOAuthUser → createOAuthSession → redirect to frontend",
      "imports": [
        "import { Router } from 'express'",
        "import crypto from 'crypto'",
        "import { getAuthorizationUrl, exchangeCodeForTokens, getOrCreateOAuthUser, createOAuthSession } from './oauth.service'"
      ],
      "typesInScope": [],
      "testMock": [],
      "dangerZones": [
        "L23-L28 CSRF state cookie 设置——不要改 SameSite 或 httpOnly 属性",
        "L81 URL fragment 格式 #token=... 不要改成 query params（安全设计决策）"
      ],
      "verifiedAt": "2026-06-09 (wa3f spec verified)"
    },
    "codePatterns": [
      "参考 oauth.routes.ts:L23-L28 cookie 设置模式"
    ],
    "gotchas": [
      "⚠️ oauth.routes.ts 无测试文件——gap"
    ],
    "modelTier": "fast",
    "modelTierReason": "已完成，无新代码"
  },
  {
    "id": "frontend-auth-integration",
    "description": "前端认证集成（Axios 拦截器 + authStore + OAuth 回调）（已完成）",
    "acs": [
      "AC1: 在 api/index.ts L35-L65；请求拦截器从 localStorage（auth-storage）读取 token，注入 Authorization: Bearer header；不导入 authStore（避免循环依赖）",
      "AC2: 在 api/index.ts L70-L120；响应拦截器捕获 401，跳过 AUTH_PATHS，使用队列防并发刷新，调用 POST /auth/refresh 更新 localStorage 并重试原请求；不修改 AUTH_PATHS 列表",
      "AC3: 在 OAuthCallback.tsx；解析 window.location.hash 获取 token/refreshToken，调用 setToken + checkAuth，导航到 /channels；错误从 query params 读取并重定向到 /",
      "AC4: 在 authStore.ts；Zustand store + persist middleware（localStorage key: auth-storage），包含 init/createGuestSession/checkAuth/login/register/logout/setToken/fetchMe actions；不修改 persist 配置"
    ],
    "files": [
      "apps/web/src/api/index.ts",
      "apps/web/src/components/OAuthCallback.tsx",
      "apps/web/src/components/AuthModal.tsx",
      "apps/web/src/stores/authStore.ts"
    ],
    "dependencies": [
      "core-jwt-auth",
      "oauth-routes-csrf"
    ],
    "implementationNotes": "已完成。Axios 拦截器实现 Bearer 自动注入 + 401 刷新重试队列。authStore 使用 Zustand persist 持久化到 localStorage。OAuthCallback 解析 URL fragment。",
    "architectureContext": {
      "functions": [
        "Request interceptor @ api/index.ts:L35 — localStorage token → Bearer header",
        "Response interceptor @ api/index.ts:L70 — 401 catch → refresh queue → retry",
        "OAuthCallback component @ OAuthCallback.tsx — hash parse → setToken → checkAuth → navigate",
        "authStore.setToken @ authStore.ts — 更新 token + refreshToken state",
        "authStore.checkAuth @ authStore.ts — GET /auth/me → 更新 user state"
      ],
      "callChain": "API request → request interceptor (Bearer) → server → 401? → response interceptor → POST /auth/refresh → retry",
      "imports": [
        "import axios from 'axios'",
        "import { useAuthStore } from '../stores/authStore'"
      ],
      "typesInScope": [],
      "testMock": [],
      "dangerZones": [
        "api/index.ts L13-L14 注释：不导入 authStore 避免循环依赖——直接读 localStorage",
        "AUTH_PATHS 列表——不要添加新路径（会跳过 401 刷新）"
      ],
      "verifiedAt": "2026-06-09 (wa3f spec verified)"
    },
    "codePatterns": [
      "参考 api/index.ts:L70-L120 401 刷新队列模式"
    ],
    "gotchas": [
      "⚠️ authStore 有死代码 getAuthHeader()（wa3f 发现，未清理）"
    ],
    "modelTier": "fast",
    "modelTierReason": "已完成，无新代码"
  },
  {
    "id": "auth-middleware",
    "description": "认证中间件（requireAuth, optionalAuth, requireRole）（已完成）",
    "acs": [
      "AC1: 在 middleware/auth.ts L146-L210；requireAuth() 工厂函数返回 async middleware，验证 JWT、查找 session、附加 user/session/anonymousId 到 req；无效/过期 token 返回 401",
      "AC2: 在 middleware/auth.ts L97-L145；optionalAuth() 同 requireAuth 但无 token 时调用 next()，始终生成 anonymousId",
      "AC3: 在 middleware/auth.ts L211-L245；requireRole(...roles) 检查 session.userId 存在且 user.role 在 roles 中，否则 403"
    ],
    "files": [
      "apps/api/src/middleware/auth.ts",
      "apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts"
    ],
    "dependencies": [
      "core-jwt-auth"
    ],
    "implementationNotes": "已完成。6 个测试覆盖 requireAuth(3)、requireRole(2)、optionalAuth(3)。requireAuth 工厂在 route-registry.ts:158 调用。",
    "architectureContext": {
      "functions": [
        "requireAuth() @ L146 — factory, returns async (req, res, next)",
        "optionalAuth() @ L97 — same but calls next() without token",
        "requireRole(...roles) @ L211 — 403 if role not in roles",
        "getAuthInfo(req) @ L41 — extracts {sessionId, userId, anonymousId}",
        "checkOwnership(model, paramKey) @ L247 — admin bypass + creatorId check"
      ],
      "callChain": "route-registry.ts → requireAuth() → middleware → req.authReq = {user, session, anonymousId}",
      "imports": [
        "import { verifyToken } from '../modules/auth/service'",
        "import { prisma } from '@studio/prisma'"
      ],
      "typesInScope": [
        "AuthRequest extends Request { authReq?: { user: User; session: Session; anonymousId: string } }"
      ],
      "testMock": [
        "vi.mock('../modules/auth/service', () => ({ verifyToken: vi.fn() }))",
        "vi.mock('@studio/prisma')"
      ],
      "dangerZones": [
        "L146 requireAuth 是工厂函数——调用时必须 requireAuth() 带括号",
        "L178 session 过期检查——不要跳过 expiresAt 比较"
      ],
      "verifiedAt": "2026-06-09 (wa3f spec verified)"
    },
    "codePatterns": [
      "参考 middleware/auth.ts:L146-L210 requireAuth 工厂模式"
    ],
    "gotchas": [
      "⚠️ requireAuth() 必须作为工厂调用——不带括号传入 route 会把 middleware 实例当 handler"
    ],
    "modelTier": "fast",
    "modelTierReason": "已完成，无新代码"
  },
  {
    "id": "prisma-schema",
    "description": "Prisma 数据模型（已完成）",
    "acs": [
      "AC1: 在 schema.prisma L416-L481；定义 User（email unique, role default Guest）、Session（token unique, indexed userId/token/expiresAt）、RefreshToken（token unique, revokedAt?）、OAuthAccount（@@unique[provider, providerAccountId]）模型，配置级联删除关系",
      "AC2: 在 app.ts L78-L107；Lurk Wall PUBLIC_API 白名单包含所有 auth 路由（/auth/guest-session, /auth/register, /auth/login, /auth/github, /auth/callback/github）；生产环境生效"
    ],
    "files": [
      "packages/studio-prisma/prisma/schema.prisma",
      "apps/api/src/app.ts"
    ],
    "dependencies": [],
    "implementationNotes": "已完成。4 个模型定义完整，关系配置正确（cascade delete）。Lurk Wall 白名单包含所有公开 auth 端点。",
    "architectureContext": {
      "functions": [],
      "callChain": "schema.prisma → prisma generate → TypeScript types → service.ts / oauth.service.ts",
      "imports": [],
      "typesInScope": [
        "User { id, email, passwordHash?, name?, avatar?, role, createdAt, updatedAt }",
        "Session { id, userId?, token, guestId?, ipAddress?, userAgent?, expiresAt, createdAt }",
        "RefreshToken { id, token, userId, expiresAt, createdAt, revokedAt? }",
        "OAuthAccount { id, userId, provider, providerAccountId, accessToken?, refreshToken?, expiresAt?, profile?, createdAt, updatedAt }"
      ],
      "testMock": [],
      "dangerZones": [
        "User.role 默认 Guest——新注册用户默认为 Guest",
        "OAuthAccount @@unique[provider, providerAccountId]——不要删除"
      ],
      "verifiedAt": "2026-06-09 (wa3f spec verified)"
    },
    "codePatterns": [],
    "gotchas": [
      "⚠️ dead /auth/session 条目已从 PUBLIC_API 移除（wa3f AC3）"
    ],
    "modelTier": "fast",
    "modelTierReason": "已完成，无新代码"
  },
  {
    "id": "security-hardening",
    "description": "安全加固（wa3f spec，已完成）",
    "acs": [
      "AC1: 在 service.ts logout()；当 userId 存在时撤销该用户所有 refresh tokens（revokeAllRefreshTokensForUser），向后兼容签名扩展",
      "AC2: 在 routes.ts /cleanup 端点；添加 requireAuth() + requireRole('Admin') 中间件保护",
      "AC3: 在 app.ts PUBLIC_API Set；移除死条目 /auth/session（无对应端点）",
      "AC4: 在 service.ts login()；登录时删除该用户的过期 guest sessions",
      "AC5: 在 __tests__/service.test.ts；为 AC1-AC4 添加测试用例"
    ],
    "files": [
      "apps/api/src/modules/auth/service.ts",
      "apps/api/src/modules/auth/routes.ts",
      "apps/api/src/app.ts",
      "apps/api/src/modules/auth/__tests__/service.test.ts"
    ],
    "dependencies": [
      "core-jwt-auth",
      "refresh-token"
    ],
    "implementationNotes": "已完成（wa3f spec）。42/42 测试通过。logout 签名扩展、cleanup admin guard、dead entry 移除、guest session cleanup on login。",
    "architectureContext": {
      "functions": [
        "logout(sessionId: string, userId?: string): Promise<void> @ L275 — 扩展：userId 存在时 revoke all refresh tokens",
        "login(input: LoginInput): Promise<AuthResult> @ L151 — 扩展：登录时 cleanup expired guest sessions"
      ],
      "callChain": "POST /auth/logout → requireAuth → logout(sessionId, userId) → revokeAllRefreshTokensForUser",
      "imports": [],
      "typesInScope": [],
      "testMock": [],
      "dangerZones": [
        "logout 签名扩展必须向后兼容——userId 可选"
      ],
      "verifiedAt": "2026-06-09 (wa3f spec verified)"
    },
    "codePatterns": [],
    "gotchas": [],
    "modelTier": "fast",
    "modelTierReason": "已完成，无新代码"
  }
]
```
## Files

- apps/api/src/app.ts
- apps/api/src/middleware/auth.ts
- apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts
- apps/api/src/modules/auth/__tests__/service.test.ts
- apps/api/src/modules/auth/oauth.routes.ts
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/routes.ts
- apps/api/src/modules/auth/service.ts
- apps/web/src/api/index.ts
- apps/web/src/components/AuthModal.tsx
- apps/web/src/components/OAuthCallback.tsx
- apps/web/src/stores/authStore.ts
- packages/studio-prisma/prisma/schema.prisma