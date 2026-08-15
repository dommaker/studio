---
id: "cmq6qvmdt0011puv93qr71j0o"
goalId: "cmq6qvna1001apuv9qmjuanrt"
slug: "jwt-auth-gap-closure-oauth-redirect-fix-axios-inte"
title: "JWT Auth Gap Closure — OAuth redirect fix + Axios interceptor"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "interceptor", "token-refresh", "bug-fix"]
createdAt: "2026-06-09T14:38:13.261Z"
updatedAt: "2026-06-09T14:38:14.462Z"
---

# JWT Auth Gap Closure — OAuth redirect fix + Axios interceptor

Close 2 remaining gaps: fix reversed OAuth redirect_uri path segments, add axios request/response interceptors for Bearer token injection and auto refresh.

<!-- TASK_TIER {"tier":"standard","reason":"2 independent gaps across 2 layers (backend OAuth template fix + frontend interceptor with refresh queue), each bounded but interceptor has circular dep + concurrent refresh complexity"} -->

## Architecture Context

### oauth-redirect-fix

**Functions**
- getAuthorizationUrl(provider: OAuthProvider, state: string): string @ oauth.service.ts:L31
- exchangeGoogleCode(code: string): Promise<OAuthTokens> @ oauth.service.ts:L82 — L96 also has redirect_uri template
- exchangeGitHubCode(code: string): Promise<OAuthTokens> @ oauth.service.ts:L143 — no redirect_uri in GitHub exchange (only in body, not used)

**Call Chain**
oauth.routes.ts:GET /:provider → getAuthorizationUrl() → redirect to provider consent screen → provider redirects to GET /callback/:provider → exchangeCodeForTokens() → getOrCreateOAuthUser() → createOAuthSession()

**Imports**
- import { generateRefreshToken, JWT_SECRET } from './service.js' (already at L9)

**Types in Scope**
- OAuthProvider = 'google' | 'github' @ oauth.service.ts:L11
- OAuthProfile { provider, providerAccountId, email, name, avatar } @ oauth.service.ts:L13
- OAuthTokens { accessToken, refreshToken, expiresAt } @ oauth.service.ts:L21

**Test Mocks**
- vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('mock-jwt-token') }, sign: vi.fn().mockReturnValue('mock-jwt-token') } }))
- vi.mock('@dommaker/studio-prisma', () => ({ prisma: { ... } })) — already in test file

**Danger Zones**
- L85 exchangeGoogleCode also has redirect_uri at L96 `${redirectBase}/google/callback` — MUST sync with L40 fix
- L32 redirectBase defaults to 'http://localhost:3001/api/v1/auth' — correct base, only template suffix is wrong
- Do NOT change redirectBase env var or its default — only change the template suffix

### axios-interceptor-and-refresh

**Functions**
- api (axios instance) @ api/index.ts:L6
- authApi @ api/index.ts:L145 — consumers use this for auth calls
- authStore.setToken(token, refreshToken?) @ authStore.ts:L198
- authStore.getAuthHeader() @ authStore.ts:L192 — exists but NOT consumed by interceptor (we read localStorage directly)

**Call Chain**
any API consumer → api.get/post → request interceptor (attach token) → HTTP → response interceptor (catch 401) → refreshTokenImpl() → retry original request

**Imports**
- import axios from 'axios' (already imported at L2)
- const API_BASE = import.meta.env.VITE_API_URL || '/api/v1' (already defined at L5)

**Types in Scope**
- Persisted auth-storage shape: { state: { token: string|null, refreshToken: string|null, user: User|null, session: Session|null, guestId: string|null }, version: number }
- POST /auth/refresh response: { accessToken: string, refreshToken: string, userId: string }
- AxiosRequestConfig, AxiosResponse, AxiosError — standard axios types

**Test Mocks**
- vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() })
- vi.mock('axios', () => ({ default: { create: vi.fn().mockReturnValue({ interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } }, get: vi.fn(), post: vi.fn() }), post: vi.fn() } }))

**Danger Zones**
- authStore.ts:L9 imports from '../api' — interceptor MUST NOT import authStore (circular dependency)
- POST /auth/refresh returns {accessToken, refreshToken} — field name is 'accessToken' not 'token'
- Auth endpoints (login/register/guest-session/refresh/me) must NOT trigger 401 refresh logic (infinite loop)
- zustand persist key is 'auth-storage' — hardcoded string at authStore.ts:L204
- error.config._retry flag needed to prevent infinite retry loop

## AC Groups

### oauth-redirect-fix

#### 实现指南
1. oauth.service.ts L40: `${redirectBase}/google/callback` → `${redirectBase}/callback/google`. L54: `${redirectBase}/github/callback` → `${redirectBase}/callback/github`. 2. oauth.service.test.ts: 在 getAuthorizationUrl describe 块中添加 redirect_uri 路径段顺序断言 — 用 new URL(url).searchParams.get('redirect_uri') 提取后 assert toMatch(/\/callback\/google$/). 3. exchangeGoogleCode/exchangeGitHubCode 中也有 redirect_uri（L96）— 需要同步修改（用于 token exchange，必须和 authorization URL 一致）。4. redirectBase 默认值 'http://localhost:3001/api/v1/auth' 不变。

#### 参考模式
- oauth.service.ts:L31-L59 getAuthorizationUrl switch-case pattern
- oauth.service.test.ts:L62-L90 existing getAuthorizationUrl test block

#### ⚠️ 注意事项
- ⚠️ exchangeGoogleCode L96 also has `${redirectBase}/google/callback` — MUST sync fix, token exchange redirect_uri must match authorization URL
- ⚠️ x6dy spec previously claimed redirect_uri was correct — WRONG. Confirmed reversed at L40, L54, L96.
- ⚠️ Do not change redirectBase env var — only template suffix `/google/callback` → `/callback/google`

### axios-interceptor-and-refresh

#### 实现指南
1. Request interceptor: api.interceptors.request.use(config => { const stored = JSON.parse(localStorage.getItem('auth-storage') || '{}'); const token = stored?.state?.token; if (token) config.headers.Authorization = `Bearer ${token}`; return config; }). 2. Response interceptor with refresh queue: let isRefreshing = false; let failedQueue: Array<{resolve: (token: string) => void; reject: (err: unknown) => void}> = []; On 401 + non-auth path: if isRefreshing → queue promise; else set isRefreshing=true, call refreshTokenImpl(stored.state.refreshToken), on success update localStorage + flush queue with new token + retry original, on fail clear localStorage + redirect + reject queue. 3. refreshTokenImpl uses axios.post(API_BASE + '/auth/refresh', {refreshToken}) — NOT the api instance. 4. POST /auth/refresh returns {accessToken, refreshToken, userId} (routes.ts:L189-193) — field is 'accessToken' not 'token'. 5. Auth path exclusion: check config.url against ['/auth/login', '/auth/register', '/auth/guest-session', '/auth/refresh', '/auth/me'] — skip refresh for these. 6. Guard: response interceptor must check error.config._retry to avoid infinite loop on retry.

#### 参考模式
- authStore.ts:L203-212 zustand persist config — partialize shape reference
- routes.ts:L177-197 POST /refresh endpoint — response shape {accessToken, refreshToken, userId}
- authStore.ts:L192-196 getAuthHeader — token extraction pattern

#### ⚠️ 注意事项
- ⚠️ CRITICAL: authStore.ts:L9 `import { authApi } from '../api'` — interceptor MUST NOT import authStore. Read localStorage directly.
- ⚠️ POST /auth/refresh returns `accessToken` not `token` — map accordingly when updating localStorage
- ⚠️ Guard refresh logic against auth endpoints: /auth/login, /auth/register, /auth/guest-session, /auth/refresh, /auth/me — skip interceptor for these
- ⚠️ Concurrent 401s: use single isRefreshing flag + queue pattern to avoid multiple simultaneous refresh calls
- ⚠️ localStorage key 'auth-storage' is hardcoded in zustand persist config (authStore.ts:L204)
- ⚠️ error.config._retry must be set to prevent infinite retry loop on the retried request