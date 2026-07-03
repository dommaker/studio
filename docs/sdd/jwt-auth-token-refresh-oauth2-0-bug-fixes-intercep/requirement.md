---
id: "cmq6fqaz601gyqnnhec16qze3"
workUnitId: "cmq6fqdxn01hlqnnh91lgdvfm"
slug: "jwt-auth-token-refresh-oauth2-0-bug-fixes-intercep"
title: "JWT Auth + Token Refresh + OAuth2.0 — Bug Fixes & Interceptor"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "security", "frontend", "backend", "bug-fix"]
createdAt: "2026-06-09T09:26:09.415Z"
updatedAt: "2026-06-09T09:26:13.409Z"
---

# JWT Auth + Token Refresh + OAuth2.0 — Bug Fixes & Interceptor

Fix 4 critical bugs preventing JWT auth from working (payload mismatch, redirect_uri, SECRET inconsistency, PUBLIC_API), add frontend axios interceptor with refresh token auto-renewal

<!-- TASK_TIER {"tier":"premium","reason":"Cross-module (backend+frontend), security-sensitive JWT/OAuth, 4 critical bugs + new interceptor, 6 files"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["Prisma models: User, Session, RefreshToken, OAuthAccount — schema.prisma L415-L480","Auth service: verifyToken reads {sid, uid} — service.ts:L84-L86","Auth service: generateToken signs {sid, uid} — service.ts:L75-L77","OAuth service: createOAuthSession signs {sessionId, userId} — oauth.service.ts:L334-L335 (BUG: should be {sid, uid})","OAuth routes mounted at /api/v1/auth — route-registry.ts:L165","OAuth routes: GET /:provider and GET /callback/:provider — oauth.routes.ts:L18,L43","Frontend getOAuthUrl returns /api/v1/auth/${provider} — api/index.ts:L157 (CORRECT, matches backend)","Frontend OAuthCallback at /auth/callback — App.tsx:L139 bypasses guest wall","PUBLIC_API includes /auth/google, /auth/callback/google — app.ts:L83-L84","cookie-parser in middleware chain — app.ts:L33","Zustand persist key 'auth-storage' — authStore.ts:L204"],"unverified":[],"newRequired":["Axios request interceptor — does not exist in api/index.ts","Axios 401 response interceptor with refresh token retry — does not exist"]} -->

### Verified
- ✅ Prisma models: User, Session, RefreshToken, OAuthAccount — schema.prisma L415-L480
- ✅ Auth service: verifyToken reads {sid, uid} — service.ts:L84-L86
- ✅ Auth service: generateToken signs {sid, uid} — service.ts:L75-L77
- ✅ OAuth service: createOAuthSession signs {sessionId, userId} — oauth.service.ts:L334-L335 (BUG: should be {sid, uid})
- ✅ OAuth routes mounted at /api/v1/auth — route-registry.ts:L165
- ✅ OAuth routes: GET /:provider and GET /callback/:provider — oauth.routes.ts:L18,L43
- ✅ Frontend getOAuthUrl returns /api/v1/auth/${provider} — api/index.ts:L157 (CORRECT, matches backend)
- ✅ Frontend OAuthCallback at /auth/callback — App.tsx:L139 bypasses guest wall
- ✅ PUBLIC_API includes /auth/google, /auth/callback/google — app.ts:L83-L84
- ✅ cookie-parser in middleware chain — app.ts:L33
- ✅ Zustand persist key 'auth-storage' — authStore.ts:L204

### 🆕 New Required
- 📝 Axios request interceptor — does not exist in api/index.ts
- 📝 Axios 401 response interceptor with refresh token retry — does not exist

## AC Groups

### backend-oauth-jwt-fixes
<!-- MODEL_TIER {"tier":"standard","reason":"2 files, surgical fixes to existing code, but JWT field change is security-sensitive and redirect_uri fix affects OAuth flow"} -->

#### 验收标准
- [ ] AC1.1: 在 oauth.service.ts L334；将 JWT payload 从 {sessionId: session.id, userId} 改为 {sid: session.id, uid: userId} 以匹配 service.ts:L76 generateToken 和 middleware verifyToken 的字段名；不修改 service.ts 的 generateToken/verifyToken（已正确使用 sid/uid）
- [ ] AC1.2: 在 oauth.service.ts L27；将 JWT_SECRET fallback 从 'dev-secret-change-me' 改为复用 service.ts 的逻辑（import { JWT_SECRET } from './service.js' 或提取到 shared config）；消除两个模块使用不同 fallback secret 的风险
- [ ] AC1.3: 在 oauth.service.ts L33；将 OAUTH_REDIRECT_BASE 默认值从 'http://localhost:3001/api/v1/auth/oauth' 改为 'http://localhost:3001/api/v1/auth'（当前默认值导致 redirect_uri 为 .../auth/oauth/google/callback，但实际回调路由是 .../auth/callback/google）；同步修改 L86 的 Google token exchange 中的相同默认值
- [ ] AC1.4: 在 app.ts L78-L94 PUBLIC_API Set 中；添加 '/auth/register'（当前缺失，生产环境新用户注册被 Lurk Wall 拦截返回 401）；不修改其他已有条目

#### 涉及文件
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/app.ts

### frontend-auth-interceptor
<!-- MODEL_TIER {"tier":"standard","reason":"Single file but complex async logic (refresh queue, concurrent request handling, circular dep avoidance, localStorage parsing)"} -->

#### 验收标准
- [ ] AC2.1: 在 api/index.ts L6-L10 axios.create() 后；添加 request interceptor 从 localStorage key 'auth-storage' (Zustand persist key) 读取 state.token 并设置 Authorization: Bearer header；不 import authStore（循环依赖：authStore.ts L9 imports from '../api'）
- [ ] AC2.2: 在 api/index.ts；添加 response interceptor：收到 401 时读取 localStorage 中的 refreshToken，调用 POST /auth/refresh，成功后更新 localStorage 中的 token 并重试原请求；refresh 失败时清除 auth-storage 并 reload；用 isRefreshing 标志 + pending queue 防止并发刷新
- [ ] AC2.3: 在 api/index.ts response interceptor 中；排除 /auth/login、/auth/register、/auth/guest-session、/auth/refresh 路径不触发 401 自动刷新（防止登录失败触发无意义刷新循环）

#### 涉及文件
- apps/web/src/api/index.ts

#### 依赖: backend-oauth-jwt-fixes
## 约束
- Auth interceptor MUST NOT import authStore (circular dependency: authStore.ts L9 imports from '../api')
- JWT_SECRET must be same in service.ts and oauth.service.ts — currently different fallbacks
- OAuth redirect path /auth/callback must match App.tsx L139 pathname check
- PUBLIC_API only applies in production (app.ts L77) — dev/test bypass
- OAuth callback uses cookie-parser for CSRF state verification — confirmed in app.ts L33
- Frontend getOAuthUrl (/auth/${provider}) is CORRECT — do NOT change to /auth/oauth/${provider}
- OAuth routes mounted at /api/v1/auth (NOT /api/v1/auth/oauth) — route-registry.ts L165

## AC Groups

```json
[
  {
    "id": "backend-oauth-jwt-fixes",
    "acs": [
      "AC1.1: 在 oauth.service.ts L334；将 JWT payload 从 {sessionId: session.id, userId} 改为 {sid: session.id, uid: userId} 以匹配 service.ts:L76 generateToken 和 middleware verifyToken 的字段名；不修改 service.ts 的 generateToken/verifyToken（已正确使用 sid/uid）",
      "AC1.2: 在 oauth.service.ts L27；将 JWT_SECRET fallback 从 'dev-secret-change-me' 改为复用 service.ts 的逻辑（import { JWT_SECRET } from './service.js' 或提取到 shared config）；消除两个模块使用不同 fallback secret 的风险",
      "AC1.3: 在 oauth.service.ts L33；将 OAUTH_REDIRECT_BASE 默认值从 'http://localhost:3001/api/v1/auth/oauth' 改为 'http://localhost:3001/api/v1/auth'（当前默认值导致 redirect_uri 为 .../auth/oauth/google/callback，但实际回调路由是 .../auth/callback/google）；同步修改 L86 的 Google token exchange 中的相同默认值",
      "AC1.4: 在 app.ts L78-L94 PUBLIC_API Set 中；添加 '/auth/register'（当前缺失，生产环境新用户注册被 Lurk Wall 拦截返回 401）；不修改其他已有条目"
    ],
    "files": [
      "apps/api/src/modules/auth/oauth.service.ts",
      "apps/api/src/app.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. oauth.service.ts L334: jwt.sign({sessionId: session.id, userId}, ...) → jwt.sign({sid: session.id, uid: userId}, ...). 2. oauth.service.ts L27: 不再单独声明 JWT_SECRET，改为从 service.ts export 或提取到 ./jwt-config.ts。service.ts L13 的逻辑（production 抛错 + dev fallback）是正确的。3. oauth.service.ts L33,L86: OAUTH_REDIRECT_BASE 默认值去掉 /oauth 后缀。4. app.ts L78-94: PUBLIC_API.add('/auth/register')。",
    "architectureContext": {
      "functions": [
        "createOAuthSession(userId: string, req: {ip?: string; headers: Record<string, string|undefined>}): Promise<{token: string; refreshToken: string; session: {id: string; expiresAt: Date}}> @ oauth.service.ts:L317-L354",
        "generateToken(sessionId: string, userId?: string): string @ service.ts:L75-L77 — signs {sid, uid}",
        "verifyToken(token: string): {sessionId: string; userId?: string} | null @ service.ts:L82-L92 — reads payload.sid, payload.uid",
        "getAuthorizationUrl(provider: OAuthProvider, state: string): string @ oauth.service.ts:L32-L64 — builds OAuth consent URL",
        "exchangeGoogleCode(code: string) @ oauth.service.ts:L83-L142 — uses OAUTH_REDIRECT_BASE at L86",
        "registerRoutes() @ app.ts:L72-L151 — defines PUBLIC_API at L78-L94"
      ],
      "callChain": "OAuth callback → oauth.routes.ts:callback handler → oauthService.createOAuthSession() → jwt.sign({sid, uid}) → redirect to frontend → OAuthCallback.tsx reads token → authStore.setToken()",
      "imports": [
        "import jwt from 'jsonwebtoken' @ oauth.service.ts:L7",
        "import { generateRefreshToken } from './service.js' @ oauth.service.ts:L9",
        "import { logger } from '@dommaker/studio-shared' @ oauth.service.ts:L6"
      ],
      "typesInScope": [
        "OAuthProvider = 'google' | 'github' @ oauth.service.ts:L11",
        "OAuthProfile { provider: OAuthProvider; providerAccountId: string; email: string; name: string|null; avatar: string|null } @ oauth.service.ts:L13-L19",
        "OAuthTokens { accessToken: string; refreshToken: string|null; expiresAt: Date|null } @ oauth.service.ts:L21-L25"
      ],
      "testMock": [
        "vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('mock-jwt'), verify: vi.fn().mockReturnValue({sid: 'sess-1', uid: 'user-1'}) }, sign: vi.fn(), verify: vi.fn() }))",
        "vi.mock('@dommaker/studio-prisma', () => ({ prisma: { session: { create: vi.fn(), update: vi.fn() }, refreshToken: { create: vi.fn() } } }))"
      ],
      "dangerZones": [
        "oauth.service.ts L27: JWT_SECRET 有 fallback 'dev-secret-change-me' — 与 service.ts L13 不同，必须统一",
        "oauth.service.ts L334: 当前签 {sessionId, userId}，middleware 读 {sid, uid} — OAuth token 验证必定失败",
        "app.ts L77: PUBLIC_API 只在 NODE_ENV=production 时生效 — dev/test 不走此检查",
        "oauth.routes.ts L47: req.cookies 依赖 cookie-parser 中间件 — 已确认在 app.ts L33"
      ],
      "verifiedAt": "working tree @ 41cecb5"
    },
    "codePatterns": [
      "service.ts:L75-L77 — canonical JWT sign: jwt.sign({ sid: sessionId, uid: userId }, JWT_SECRET, { expiresIn })",
      "service.ts:L82-L92 — canonical JWT verify: jwt.verify → { sessionId: payload.sid, userId: payload.uid }",
      "service.ts:L13 — JWT_SECRET with production guard: process.env.JWT_SECRET || (production ? throw : 'dev-fallback')"
    ],
    "gotchas": [
      "⚠️ oauth.service.ts L27 JWT_SECRET fallback 'dev-secret-change-me' vs service.ts L13 'dev-jwt-secret-change-in-production' — 两个不同 fallback，无 env var 时 token 互不认可",
      "⚠️ oauth.service.ts L33 OAUTH_REDIRECT_BASE 默认含 /oauth — 导致 redirect_uri .../auth/oauth/google/callback，实际路由 .../auth/callback/google，Google OAuth 报 redirect_uri_mismatch",
      "⚠️ AC3.1 in previous analysis (n0m4) would change getOAuthUrl to /auth/oauth/${provider} — this is WRONG. Frontend path /auth/${provider} is CORRECT. oauth.routes.ts is mounted at /api/v1/auth with routes /:provider. Do NOT change frontend getOAuthUrl.",
      "⚠️ 不要删除 oauth.service.ts 的 OAUTH_REDIRECT_BASE env var 支持 — 生产环境可能配置了自定义域名"
    ],
    "modelTier": "standard",
    "modelTierReason": "2 files, surgical fixes to existing code, but JWT field change is security-sensitive and redirect_uri fix affects OAuth flow"
  },
  {
    "id": "frontend-auth-interceptor",
    "acs": [
      "AC2.1: 在 api/index.ts L6-L10 axios.create() 后；添加 request interceptor 从 localStorage key 'auth-storage' (Zustand persist key) 读取 state.token 并设置 Authorization: Bearer header；不 import authStore（循环依赖：authStore.ts L9 imports from '../api'）",
      "AC2.2: 在 api/index.ts；添加 response interceptor：收到 401 时读取 localStorage 中的 refreshToken，调用 POST /auth/refresh，成功后更新 localStorage 中的 token 并重试原请求；refresh 失败时清除 auth-storage 并 reload；用 isRefreshing 标志 + pending queue 防止并发刷新",
      "AC2.3: 在 api/index.ts response interceptor 中；排除 /auth/login、/auth/register、/auth/guest-session、/auth/refresh 路径不触发 401 自动刷新（防止登录失败触发无意义刷新循环）"
    ],
    "files": [
      "apps/web/src/api/index.ts"
    ],
    "dependencies": [
      "backend-oauth-jwt-fixes"
    ],
    "implementationNotes": "1. Request interceptor: read from localStorage key 'auth-storage', parse JSON, extract state.token. 2. Response interceptor: on 401, check URL against auth endpoint exclusion list, read refreshToken from localStorage, POST /auth/refresh with {refreshToken}, on success update localStorage token + retry with new Authorization header, on failure clear localStorage + window.location.reload(). 3. Use isRefreshing flag + queue pattern to prevent concurrent refresh storms. 4. Do NOT import useAuthStore — circular dependency. 5. POST /auth/refresh returns {accessToken, refreshToken} — use accessToken as new token.",
    "architectureContext": {
      "functions": [
        "axios.create({baseURL, headers, withCredentials}) @ api/index.ts:L6-L10 — current instance, no interceptors",
        "authApi @ api/index.ts:L145-L158 — auth API methods, consumer of axios instance",
        "useAuthStore @ authStore.ts:L56-L210 — Zustand store, imports authApi (circular dep constraint)"
      ],
      "callChain": "any API call → request interceptor (attach token from localStorage) → HTTP → response interceptor (401? → POST /auth/refresh → update localStorage → retry) → original caller",
      "imports": [
        "import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios' @ api/index.ts:L2"
      ],
      "typesInScope": [
        "InternalAxiosRequestConfig — axios request config type with _retry custom field",
        "AxiosError — axios error type with response.status",
        "LocalStorage 'auth-storage' shape: {state: {token: string, refreshToken: string, user: object, session: object, guestId: string}, version: number}"
      ],
      "testMock": [
        "vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() })",
        "vi.mock('axios', () => ({ default: { create: vi.fn(() => mockAxiosInstance), post: vi.fn() } }))"
      ],
      "dangerZones": [
        "authStore.ts L9: import { authApi } from '../api' — interceptor MUST NOT import authStore. Use direct localStorage reads.",
        "Zustand persist key is 'auth-storage' (authStore.ts L204) — localStorage shape: {state: {...}, version: 0}",
        "api/index.ts L14 uses 'any' type in taskApi — don't touch, out of scope"
      ],
      "verifiedAt": "working tree @ 41cecb5"
    },
    "codePatterns": [
      "authStore.ts L191-L195 — getAuthHeader pattern: { Authorization: `Bearer ${token}` }",
      "authStore.ts L200-L208 — partialize pattern: persists token, refreshToken, user, session, guestId",
      "authStore.ts L198-L199 — setToken: set({ token, ...(refreshToken ? { refreshToken } : {}) })"
    ],
    "gotchas": [
      "⚠️ Circular dependency: authStore.ts L9 imports from '../api'. Interceptor MUST read localStorage directly, not import authStore.",
      "⚠️ Zustand persist localStorage key is 'auth-storage', shape is {state: {token, refreshToken, ...}, version: number} — must parse correctly.",
      "⚠️ Refresh token endpoint is POST /auth/refresh, returns {accessToken, refreshToken} — not {token, refreshToken}. Use accessToken as the new Bearer token.",
      "⚠️ After successful refresh, must update localStorage AND retry original request with new Authorization header.",
      "⚠️ Must handle concurrent requests: if multiple 401s arrive simultaneously, only one refresh should fire. Queue pending requests and replay after refresh completes."
    ],
    "modelTier": "standard",
    "modelTierReason": "Single file but complex async logic (refresh queue, concurrent request handling, circular dep avoidance, localStorage parsing)"
  }
]
```

## Files

- apps/api/src/app.ts
- apps/api/src/modules/auth/oauth.service.ts
- apps/web/src/api/index.ts