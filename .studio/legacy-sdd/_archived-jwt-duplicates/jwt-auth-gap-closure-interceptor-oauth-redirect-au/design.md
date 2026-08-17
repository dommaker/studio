---
id: "cmq6kkre4004zeeiw7by0eec4"
goalId: "cmq6kkspe005eeeiwzpma2b2x"
slug: "jwt-auth-gap-closure-interceptor-oauth-redirect-au"
title: "JWT Auth Gap Closure — Interceptor + OAuth redirect + Auto Refresh"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "interceptor", "token-refresh", "bug-fix"]
createdAt: "2026-06-09T11:41:48.840Z"
updatedAt: "2026-06-09T11:41:50.588Z"
---

# JWT Auth Gap Closure — Interceptor + OAuth redirect + Auto Refresh

Close 3 remaining gaps in the auth system: axios interceptor (no auth headers sent), OAuth redirect_uri reversed segments, and missing auto token refresh on frontend.

<!-- TASK_TIER {"tier":"standard","reason":"3 independent gaps across 2 layers (backend OAuth fix + frontend interceptor/refresh), each simple but collectively require coordinated verification"} -->

## Architecture Context

### oauth-redirect-fix

**Functions**
- getAuthorizationUrl(provider: OAuthProvider, state: string): string @ oauth.service.ts:L31
- exchangeGoogleCode(code: string): Promise<OAuthTokens> @ oauth.service.ts:L82
- exchangeGitHubCode(code: string): Promise<OAuthTokens> @ oauth.service.ts:L143

**Call Chain**
oauth.routes.ts:GET /:provider → getAuthorizationUrl() → redirect to provider consent screen → provider redirects to GET /callback/:provider → exchangeCodeForTokens() → getOrCreateOAuthUser() → createOAuthSession()

**Imports**
- import { generateRefreshToken, JWT_SECRET } from './service.js'

**Types in Scope**
- OAuthProvider = 'google' | 'github' @ oauth.service.ts:L11
- OAuthProfile { provider, providerAccountId, email, name, avatar } @ oauth.service.ts:L13
- OAuthTokens { accessToken, refreshToken, expiresAt } @ oauth.service.ts:L21

**Danger Zones**
- L32 redirectBase defaults to 'http://localhost:3001/api/v1/auth' — correct base, only template suffix is wrong
- Do NOT change redirectBase env var or its default — only change the template suffix

### axios-interceptor-and-refresh

**Functions**
- api (axios instance) @ api/index.ts:L6
- authApi @ api/index.ts:L145 — consumers use this for auth calls
- authStore.setToken(token, refreshToken?) @ authStore.ts:L198
- authStore.getAuthHeader() @ authStore.ts:L192 — exists but NOT consumed by interceptor (we read localStorage directly)

**Call Chain**
any API consumer → api.get/post → request interceptor (attach token) → HTTP → response interceptor (catch 401) → refreshToken() → retry original

**Imports**
- import axios from 'axios' (already imported at L2)
- const API_BASE = import.meta.env.VITE_API_URL || '/api/v1' (already defined at L5)

**Types in Scope**
- Persisted auth-storage shape: { state: { token: string|null, refreshToken: string|null, user: User|null, session: Session|null, guestId: string|null }, version: number }
- POST /auth/refresh response: { accessToken: string, refreshToken: string, userId: string }

**Test Mocks**
- const mockLocalStorage = { 'auth-storage': JSON.stringify({ state: { token: 'test-token', refreshToken: 'test-refresh' }, version: 0 }) }; Object.defineProperty(window, 'localStorage', { value: { getItem: (k) => mockLocalStorage[k] || null, setItem: vi.fn(), removeItem: vi.fn() } });
- vi.mock('axios', () => ({ default: { create: () => mockAxiosInstance, post: vi.fn() } }))

**Danger Zones**
- authStore.ts:L9 imports from '../api' — interceptor MUST NOT import authStore (circular dependency)
- POST /auth/refresh returns {accessToken, refreshToken} — field name is 'accessToken' not 'token'
- Auth endpoints (login/register/guest-session/refresh) must NOT trigger 401 refresh logic (infinite loop)
- zustand persist key is 'auth-storage' — hardcoded string, not derived from store name

## AC Groups

### oauth-redirect-fix

#### 实现指南
1. oauth.service.ts L40: `${redirectBase}/google/callback` → `${redirectBase}/callback/google`. L54: `${redirectBase}/github/callback` → `${redirectBase}/callback/github`. 2. oauth.service.test.ts: find assertions on redirect_uri (likely L50-80 range), update expected path segment order. 3. No other files affected — oauth.routes.ts callback handler path is already /callback/:provider.

#### 参考模式
- oauth.service.ts:L31-L59 getAuthorizationUrl switch-case pattern

#### ⚠️ 注意事项
- ⚠️ x6dy spec previously claimed redirect_uri was correct — WRONG. Confirmed reversed segments at L40 and L54.
- ⚠️ Do not change redirectBase env var — only the template suffix `/google/callback` → `/callback/google`

### axios-interceptor-and-refresh

#### 实现指南
1. Read localStorage key 'auth-storage', JSON.parse, extract state.token. 2. Request interceptor: api.interceptors.request.use(config => { const stored = JSON.parse(localStorage.getItem('auth-storage') || '{}'); const token = stored?.state?.token; if (token) config.headers.Authorization = `Bearer ${token}`; return config; }). 3. Response interceptor with refresh queue: let isRefreshing = false; let failedQueue: Array<{resolve, reject}> = []; On 401 (not already retried): if isRefreshing → queue; else set isRefreshing=true, call refreshToken(stored.state.refreshToken), on success update localStorage + retry queued + retry original, on fail clear localStorage + window.location.href='/'. 4. Refresh function uses standalone axios.post(API_BASE + '/auth/refresh', {refreshToken}) — NOT the `api` instance. 5. POST /auth/refresh returns {accessToken, refreshToken, userId} (routes.ts:L189-193) — note field is 'accessToken' not 'token'. 6. Guard: skip refresh for auth endpoints themselves (login/register/guest-session/refresh) to avoid infinite loops.

#### 参考模式
- authStore.ts:L203-212 zustand persist config — partialize shape reference
- routes.ts:L177-197 POST /refresh endpoint — response shape {accessToken, refreshToken, userId}
- authStore.ts:L192-196 getAuthHeader — token extraction pattern

#### ⚠️ 注意事项
- ⚠️ CRITICAL: authStore.ts:L9 `import { authApi } from '../api'` — interceptor MUST NOT import authStore. Read localStorage directly.
- ⚠️ POST /auth/refresh returns `accessToken` not `token` — map accordingly when updating localStorage
- ⚠️ Guard refresh logic against auth endpoints: /auth/login, /auth/register, /auth/guest-session, /auth/refresh — skip interceptor for these
- ⚠️ Concurrent 401s: use single isRefreshing flag + queue pattern to avoid multiple simultaneous refresh calls
- ⚠️ localStorage key 'auth-storage' is hardcoded in zustand persist config (authStore.ts:L204)