---
id: "cmq6qvmdt0011puv93qr71j0o"
workUnitId: "cmq6qvna1001apuv9qmjuanrt"
slug: "jwt-auth-gap-closure-oauth-redirect-fix-axios-inte"
title: "JWT Auth Gap Closure — OAuth redirect fix + Axios interceptor"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "interceptor", "token-refresh", "bug-fix"]
createdAt: "2026-06-09T14:38:13.261Z"
updatedAt: "2026-06-09T14:38:14.462Z"
---

# JWT Auth Gap Closure — OAuth redirect fix + Axios interceptor

Close 2 remaining gaps: fix reversed OAuth redirect_uri path segments, add axios request/response interceptors for Bearer token injection and auto refresh.

<!-- TASK_TIER {"tier":"standard","reason":"2 independent gaps across 2 layers (backend OAuth template fix + frontend interceptor with refresh queue), each bounded but interceptor has circular dep + concurrent refresh complexity"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["POST /api/v1/auth/refresh — routes.ts:L177, returns {accessToken, refreshToken, userId}","GET /api/v1/auth/callback/:provider — oauth.routes.ts:L43, mounted at /api/v1/auth","GET /api/v1/auth/:provider — oauth.routes.ts:L18, mounted at /api/v1/auth","localStorage key 'auth-storage' — authStore.ts:L204 zustand persist, shape {state:{token,refreshToken,user,session,guestId},version:0}","axios.create returns AxiosInstance with .interceptors.request.use() and .interceptors.response.use() — standard axios API","OAuth token fragment already fixed — oauth.routes.ts:L81 uses #, OAuthCallback.tsx:L28 parses hash"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ POST /api/v1/auth/refresh — routes.ts:L177, returns {accessToken, refreshToken, userId}
- ✅ GET /api/v1/auth/callback/:provider — oauth.routes.ts:L43, mounted at /api/v1/auth
- ✅ GET /api/v1/auth/:provider — oauth.routes.ts:L18, mounted at /api/v1/auth
- ✅ localStorage key 'auth-storage' — authStore.ts:L204 zustand persist, shape {state:{token,refreshToken,user,session,guestId},version:0}
- ✅ axios.create returns AxiosInstance with .interceptors.request.use() and .interceptors.response.use() — standard axios API
- ✅ OAuth token fragment already fixed — oauth.routes.ts:L81 uses #, OAuthCallback.tsx:L28 parses hash

## AC Groups

### oauth-redirect-fix
<!-- MODEL_TIER {"tier":"fast","reason":"2 files, string template changes at 3 locations (L40, L54, L96), existing tests guide exact locations, no cross-module dependency"} -->

#### 验收标准
- [ ] AC1.1: 在 oauth.service.ts L40；将 redirect_uri 模板从 `${redirectBase}/google/callback` 改为 `${redirectBase}/callback/google`；确保与 oauth.routes.ts L43 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数
- [ ] AC1.2: 在 oauth.service.ts L54；将 redirect_uri 模板从 `${redirectBase}/github/callback` 改为 `${redirectBase}/callback/github`；确保与 oauth.routes.ts L43 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数
- [ ] AC1.3: 在 oauth.service.test.ts L62-L90 getAuthorizationUrl 测试块；添加断言验证 redirect_uri 路径段顺序为 /callback/{provider}（用 URL.searchParams.get('redirect_uri') 解析后断言）；保留现有其他断言不变

#### 涉及文件
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts

### axios-interceptor-and-refresh
<!-- MODEL_TIER {"tier":"standard","reason":"1 file but non-trivial: request + response interceptor + refresh queue + localStorage parsing + concurrent request handling + circular dep constraint + 48+ consumer impact"} -->

#### 验收标准
- [ ] AC2.1: 在 apps/web/src/api/index.ts L6-L10 的 axios 实例上添加 request interceptor；从 localStorage 读取 'auth-storage' key，JSON.parse 提取 state.token；token 存在时附加 Authorization: Bearer header；token 不存在时不附加 header；不 import authStore（circular dep: authStore.ts:L9 imports from '../api'）
- [ ] AC2.2: 在 apps/web/src/api/index.ts 添加 response interceptor；收到 401 且非 auth 路径时尝试 POST /auth/refresh（从 localStorage 读 refreshToken）；refresh 成功后更新 localStorage 的 state.token 和 state.refreshToken，用新 token 重试原请求；refresh 失败时清除 localStorage 'auth-storage' 并 window.location.href='/'；排除路径: /auth/login, /auth/register, /auth/guest-session, /auth/refresh, /auth/me
- [ ] AC2.3: 在 apps/web/src/api/index.ts 添加并发 401 处理；用 isRefreshing 标志 + failedQueue 模式；isRefreshing=true 时新 401 入队等待；refresh 完成后批量 resolve 队列（用新 token 重试）；refresh 失败时批量 reject 队列
- [ ] AC2.4: 在 apps/web/src/api/index.ts 导出 refreshToken 函数；接受 refreshToken 参数，用独立 axios 实例（非 api）调用 POST /auth/refresh；返回 {accessToken, refreshToken}；不 import authStore

#### 涉及文件
- apps/web/src/api/index.ts
## 约束
- MUST NOT import authStore in interceptor code (circular dependency: authStore.ts:L9 imports from '../api')
- MUST read localStorage directly for token/refreshToken
- POST /auth/refresh returns {accessToken, refreshToken, userId} — not {token, refreshToken}
- OAuth redirect_uri must match route path /callback/:provider, not /:provider/callback
- Auth endpoints (login/register/guest-session/refresh/me) must bypass 401 refresh logic
- Interceptor changes are frontend-only, no backend changes needed for interceptor
- exchangeGoogleCode L96 also has redirect_uri — must sync with L40 fix

## AC Groups

```json
[
  {
    "id": "oauth-redirect-fix",
    "acs": [
      "AC1.1: 在 oauth.service.ts L40；将 redirect_uri 模板从 `${redirectBase}/google/callback` 改为 `${redirectBase}/callback/google`；确保与 oauth.routes.ts L43 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数",
      "AC1.2: 在 oauth.service.ts L54；将 redirect_uri 模板从 `${redirectBase}/github/callback` 改为 `${redirectBase}/callback/github`；确保与 oauth.routes.ts L43 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数",
      "AC1.3: 在 oauth.service.test.ts L62-L90 getAuthorizationUrl 测试块；添加断言验证 redirect_uri 路径段顺序为 /callback/{provider}（用 URL.searchParams.get('redirect_uri') 解析后断言）；保留现有其他断言不变"
    ],
    "files": [
      "apps/api/src/modules/auth/oauth.service.ts",
      "apps/api/src/modules/auth/__tests__/oauth.service.test.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. oauth.service.ts L40: `${redirectBase}/google/callback` → `${redirectBase}/callback/google`. L54: `${redirectBase}/github/callback` → `${redirectBase}/callback/github`. 2. oauth.service.test.ts: 在 getAuthorizationUrl describe 块中添加 redirect_uri 路径段顺序断言 — 用 new URL(url).searchParams.get('redirect_uri') 提取后 assert toMatch(/\\/callback\\/google$/). 3. exchangeGoogleCode/exchangeGitHubCode 中也有 redirect_uri（L96）— 需要同步修改（用于 token exchange，必须和 authorization URL 一致）。4. redirectBase 默认值 'http://localhost:3001/api/v1/auth' 不变。",
    "architectureContext": {
      "functions": [
        "getAuthorizationUrl(provider: OAuthProvider, state: string): string @ oauth.service.ts:L31",
        "exchangeGoogleCode(code: string): Promise<OAuthTokens> @ oauth.service.ts:L82 — L96 also has redirect_uri template",
        "exchangeGitHubCode(code: string): Promise<OAuthTokens> @ oauth.service.ts:L143 — no redirect_uri in GitHub exchange (only in body, not used)"
      ],
      "callChain": "oauth.routes.ts:GET /:provider → getAuthorizationUrl() → redirect to provider consent screen → provider redirects to GET /callback/:provider → exchangeCodeForTokens() → getOrCreateOAuthUser() → createOAuthSession()",
      "imports": [
        "import { generateRefreshToken, JWT_SECRET } from './service.js' (already at L9)"
      ],
      "typesInScope": [
        "OAuthProvider = 'google' | 'github' @ oauth.service.ts:L11",
        "OAuthProfile { provider, providerAccountId, email, name, avatar } @ oauth.service.ts:L13",
        "OAuthTokens { accessToken, refreshToken, expiresAt } @ oauth.service.ts:L21"
      ],
      "testMock": [
        "vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('mock-jwt-token') }, sign: vi.fn().mockReturnValue('mock-jwt-token') } }))",
        "vi.mock('@dommaker/studio-prisma', () => ({ prisma: { ... } })) — already in test file"
      ],
      "dangerZones": [
        "L85 exchangeGoogleCode also has redirect_uri at L96 `${redirectBase}/google/callback` — MUST sync with L40 fix",
        "L32 redirectBase defaults to 'http://localhost:3001/api/v1/auth' — correct base, only template suffix is wrong",
        "Do NOT change redirectBase env var or its default — only change the template suffix"
      ],
      "verifiedAt": "556051f (HEAD, 2026-06-09)"
    },
    "codePatterns": [
      "oauth.service.ts:L31-L59 getAuthorizationUrl switch-case pattern",
      "oauth.service.test.ts:L62-L90 existing getAuthorizationUrl test block"
    ],
    "gotchas": [
      "⚠️ exchangeGoogleCode L96 also has `${redirectBase}/google/callback` — MUST sync fix, token exchange redirect_uri must match authorization URL",
      "⚠️ x6dy spec previously claimed redirect_uri was correct — WRONG. Confirmed reversed at L40, L54, L96.",
      "⚠️ Do not change redirectBase env var — only template suffix `/google/callback` → `/callback/google`"
    ],
    "modelTier": "fast",
    "modelTierReason": "2 files, string template changes at 3 locations (L40, L54, L96), existing tests guide exact locations, no cross-module dependency"
  },
  {
    "id": "axios-interceptor-and-refresh",
    "acs": [
      "AC2.1: 在 apps/web/src/api/index.ts L6-L10 的 axios 实例上添加 request interceptor；从 localStorage 读取 'auth-storage' key，JSON.parse 提取 state.token；token 存在时附加 Authorization: Bearer header；token 不存在时不附加 header；不 import authStore（circular dep: authStore.ts:L9 imports from '../api'）",
      "AC2.2: 在 apps/web/src/api/index.ts 添加 response interceptor；收到 401 且非 auth 路径时尝试 POST /auth/refresh（从 localStorage 读 refreshToken）；refresh 成功后更新 localStorage 的 state.token 和 state.refreshToken，用新 token 重试原请求；refresh 失败时清除 localStorage 'auth-storage' 并 window.location.href='/'；排除路径: /auth/login, /auth/register, /auth/guest-session, /auth/refresh, /auth/me",
      "AC2.3: 在 apps/web/src/api/index.ts 添加并发 401 处理；用 isRefreshing 标志 + failedQueue 模式；isRefreshing=true 时新 401 入队等待；refresh 完成后批量 resolve 队列（用新 token 重试）；refresh 失败时批量 reject 队列",
      "AC2.4: 在 apps/web/src/api/index.ts 导出 refreshToken 函数；接受 refreshToken 参数，用独立 axios 实例（非 api）调用 POST /auth/refresh；返回 {accessToken, refreshToken}；不 import authStore"
    ],
    "files": [
      "apps/web/src/api/index.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. Request interceptor: api.interceptors.request.use(config => { const stored = JSON.parse(localStorage.getItem('auth-storage') || '{}'); const token = stored?.state?.token; if (token) config.headers.Authorization = `Bearer ${token}`; return config; }). 2. Response interceptor with refresh queue: let isRefreshing = false; let failedQueue: Array<{resolve: (token: string) => void; reject: (err: unknown) => void}> = []; On 401 + non-auth path: if isRefreshing → queue promise; else set isRefreshing=true, call refreshTokenImpl(stored.state.refreshToken), on success update localStorage + flush queue with new token + retry original, on fail clear localStorage + redirect + reject queue. 3. refreshTokenImpl uses axios.post(API_BASE + '/auth/refresh', {refreshToken}) — NOT the api instance. 4. POST /auth/refresh returns {accessToken, refreshToken, userId} (routes.ts:L189-193) — field is 'accessToken' not 'token'. 5. Auth path exclusion: check config.url against ['/auth/login', '/auth/register', '/auth/guest-session', '/auth/refresh', '/auth/me'] — skip refresh for these. 6. Guard: response interceptor must check error.config._retry to avoid infinite loop on retry.",
    "architectureContext": {
      "functions": [
        "api (axios instance) @ api/index.ts:L6",
        "authApi @ api/index.ts:L145 — consumers use this for auth calls",
        "authStore.setToken(token, refreshToken?) @ authStore.ts:L198",
        "authStore.getAuthHeader() @ authStore.ts:L192 — exists but NOT consumed by interceptor (we read localStorage directly)"
      ],
      "callChain": "any API consumer → api.get/post → request interceptor (attach token) → HTTP → response interceptor (catch 401) → refreshTokenImpl() → retry original request",
      "imports": [
        "import axios from 'axios' (already imported at L2)",
        "const API_BASE = import.meta.env.VITE_API_URL || '/api/v1' (already defined at L5)"
      ],
      "typesInScope": [
        "Persisted auth-storage shape: { state: { token: string|null, refreshToken: string|null, user: User|null, session: Session|null, guestId: string|null }, version: number }",
        "POST /auth/refresh response: { accessToken: string, refreshToken: string, userId: string }",
        "AxiosRequestConfig, AxiosResponse, AxiosError — standard axios types"
      ],
      "testMock": [
        "vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() })",
        "vi.mock('axios', () => ({ default: { create: vi.fn().mockReturnValue({ interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } }, get: vi.fn(), post: vi.fn() }), post: vi.fn() } }))"
      ],
      "dangerZones": [
        "authStore.ts:L9 imports from '../api' — interceptor MUST NOT import authStore (circular dependency)",
        "POST /auth/refresh returns {accessToken, refreshToken} — field name is 'accessToken' not 'token'",
        "Auth endpoints (login/register/guest-session/refresh/me) must NOT trigger 401 refresh logic (infinite loop)",
        "zustand persist key is 'auth-storage' — hardcoded string at authStore.ts:L204",
        "error.config._retry flag needed to prevent infinite retry loop"
      ],
      "verifiedAt": "556051f (HEAD, 2026-06-09)"
    },
    "codePatterns": [
      "authStore.ts:L203-212 zustand persist config — partialize shape reference",
      "routes.ts:L177-197 POST /refresh endpoint — response shape {accessToken, refreshToken, userId}",
      "authStore.ts:L192-196 getAuthHeader — token extraction pattern"
    ],
    "gotchas": [
      "⚠️ CRITICAL: authStore.ts:L9 `import { authApi } from '../api'` — interceptor MUST NOT import authStore. Read localStorage directly.",
      "⚠️ POST /auth/refresh returns `accessToken` not `token` — map accordingly when updating localStorage",
      "⚠️ Guard refresh logic against auth endpoints: /auth/login, /auth/register, /auth/guest-session, /auth/refresh, /auth/me — skip interceptor for these",
      "⚠️ Concurrent 401s: use single isRefreshing flag + queue pattern to avoid multiple simultaneous refresh calls",
      "⚠️ localStorage key 'auth-storage' is hardcoded in zustand persist config (authStore.ts:L204)",
      "⚠️ error.config._retry must be set to prevent infinite retry loop on the retried request"
    ],
    "modelTier": "standard",
    "modelTierReason": "1 file but non-trivial: request + response interceptor + refresh queue + localStorage parsing + concurrent request handling + circular dep constraint + 48+ consumer impact"
  }
]
```

## Files

- apps/api/src/modules/auth/__tests__/oauth.service.test.ts
- apps/api/src/modules/auth/oauth.service.ts
- apps/web/src/api/index.ts