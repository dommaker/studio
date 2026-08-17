---
id: "cmq6kkre4004zeeiw7by0eec4"
workUnitId: "cmq6kkspe005eeeiwzpma2b2x"
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
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["POST /api/v1/auth/refresh — route-registry.ts:L164, routes.ts:L177, returns {accessToken, refreshToken, userId}","GET /api/v1/auth/callback/:provider — oauth.routes.ts:L43, mounted at /api/v1/auth","GET /api/v1/auth/:provider — oauth.routes.ts:L18, mounted at /api/v1/auth","localStorage key 'auth-storage' — authStore.ts:L204 zustand persist, shape {state:{token,refreshToken,user,session,guestId},version:0}","authStore.getAuthHeader() — authStore.ts:L192, returns {Authorization: Bearer <token>}"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ POST /api/v1/auth/refresh — route-registry.ts:L164, routes.ts:L177, returns {accessToken, refreshToken, userId}
- ✅ GET /api/v1/auth/callback/:provider — oauth.routes.ts:L43, mounted at /api/v1/auth
- ✅ GET /api/v1/auth/:provider — oauth.routes.ts:L18, mounted at /api/v1/auth
- ✅ localStorage key 'auth-storage' — authStore.ts:L204 zustand persist, shape {state:{token,refreshToken,user,session,guestId},version:0}
- ✅ authStore.getAuthHeader() — authStore.ts:L192, returns {Authorization: Bearer <token>}

## AC Groups

### oauth-redirect-fix
<!-- MODEL_TIER {"tier":"fast","reason":"2 files, single-line string changes, no cross-module dependencies, existing tests guide exact locations"} -->

#### 验收标准
- [ ] AC1.1: 在 oauth.service.ts L40；将 redirect_uri 模板从 `${redirectBase}/google/callback` 改为 `${redirectBase}/callback/google`；确保与路由 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数
- [ ] AC1.2: 在 oauth.service.ts L54；将 redirect_uri 模板从 `${redirectBase}/github/callback` 改为 `${redirectBase}/callback/github`；确保与路由 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数
- [ ] AC1.3: 在 oauth.service.test.ts 中更新 getAuthorizationUrl 测试；验证 redirect_uri 路径段顺序为 /callback/{provider} 而非 /{provider}/callback；保留现有其他断言不变

#### 涉及文件
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts

### axios-interceptor-and-refresh
<!-- MODEL_TIER {"tier":"standard","reason":"1 file but non-trivial: interceptor with refresh queue, localStorage parsing, concurrent request handling, circular dep constraint"} -->

#### 验收标准
- [ ] AC2.1: 在 apps/web/src/api/index.ts 的 axios 实例上添加 request interceptor；从 localStorage 读取 'auth-storage' key，解析 JSON 提取 state.token；将 token 作为 Authorization: Bearer 头附加到每个请求；token 不存在时不附加头（guest 请求正常通过）；⚠ 不 import authStore（circular dep: authStore.ts:L9 imports from '../api'）
- [ ] AC2.2: 在 apps/web/src/api/index.ts 的 axios 实例上添加 response interceptor；当收到 401 响应时，从 localStorage 读取 state.refreshToken；调用 POST /auth/refresh（直接用 axios，不用 api 实例避免循环）；refresh 成功后将新 accessToken 写回 localStorage 的 state.token 字段，新 refreshToken 写回 state.refreshToken 字段；用新 token 重试原始失败请求；refresh 失败时清除 localStorage auth-storage 并重定向到登录页；同一时间只执行一次 refresh（并发 401 排队等待同一个 refresh Promise）
- [ ] AC2.3: 在 apps/web/src/api/index.ts 添加 refreshToken 函数（导出）；接受 refreshToken 参数，调用 POST /auth/refresh，返回 {accessToken, refreshToken}；使用独立 axios 调用（非 api 实例）避免 interceptor 递归；不 import authStore
- [ ] AC2.4: 在 apps/web/src/api/index.ts 为 response interceptor 添加 isRefreshing 标志和 failedQueue；当 isRefreshing=true 时新 401 请求入队等待；refresh 完成后批量 resolve 队列中的请求（用新 token 重试）；refresh 失败时批量 reject 队列
- [ ] AC2.5: 验证 interceptor 正确处理 localStorage zustand 持久化格式；key 为 'auth-storage'，value 为 JSON {state:{token,refreshToken,...},version:0}；token 从 state.token 读取，不从顶层读取

#### 涉及文件
- apps/web/src/api/index.ts
## 约束
- MUST NOT import authStore in interceptor code (circular dependency: authStore.ts:L9 imports from '../api')
- MUST read localStorage directly for token/refreshToken
- POST /auth/refresh returns {accessToken, refreshToken, userId} — not {token, refreshToken}
- OAuth redirect_uri must match route path /callback/:provider, not /:provider/callback
- Auth endpoints (login/register/guest-session/refresh) must bypass 401 refresh logic
- Interceptor changes are frontend-only, no backend changes needed for interceptor

## AC Groups

```json
[
  {
    "id": "oauth-redirect-fix",
    "acs": [
      "AC1.1: 在 oauth.service.ts L40；将 redirect_uri 模板从 `${redirectBase}/google/callback` 改为 `${redirectBase}/callback/google`；确保与路由 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数",
      "AC1.2: 在 oauth.service.ts L54；将 redirect_uri 模板从 `${redirectBase}/github/callback` 改为 `${redirectBase}/callback/github`；确保与路由 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数",
      "AC1.3: 在 oauth.service.test.ts 中更新 getAuthorizationUrl 测试；验证 redirect_uri 路径段顺序为 /callback/{provider} 而非 /{provider}/callback；保留现有其他断言不变"
    ],
    "files": [
      "apps/api/src/modules/auth/oauth.service.ts",
      "apps/api/src/modules/auth/__tests__/oauth.service.test.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. oauth.service.ts L40: `${redirectBase}/google/callback` → `${redirectBase}/callback/google`. L54: `${redirectBase}/github/callback` → `${redirectBase}/callback/github`. 2. oauth.service.test.ts: find assertions on redirect_uri (likely L50-80 range), update expected path segment order. 3. No other files affected — oauth.routes.ts callback handler path is already /callback/:provider.",
    "architectureContext": {
      "functions": [
        "getAuthorizationUrl(provider: OAuthProvider, state: string): string @ oauth.service.ts:L31",
        "exchangeGoogleCode(code: string): Promise<OAuthTokens> @ oauth.service.ts:L82",
        "exchangeGitHubCode(code: string): Promise<OAuthTokens> @ oauth.service.ts:L143"
      ],
      "callChain": "oauth.routes.ts:GET /:provider → getAuthorizationUrl() → redirect to provider consent screen → provider redirects to GET /callback/:provider → exchangeCodeForTokens() → getOrCreateOAuthUser() → createOAuthSession()",
      "imports": [
        "import { generateRefreshToken, JWT_SECRET } from './service.js'"
      ],
      "typesInScope": [
        "OAuthProvider = 'google' | 'github' @ oauth.service.ts:L11",
        "OAuthProfile { provider, providerAccountId, email, name, avatar } @ oauth.service.ts:L13",
        "OAuthTokens { accessToken, refreshToken, expiresAt } @ oauth.service.ts:L21"
      ],
      "testMock": [],
      "dangerZones": [
        "L32 redirectBase defaults to 'http://localhost:3001/api/v1/auth' — correct base, only template suffix is wrong",
        "Do NOT change redirectBase env var or its default — only change the template suffix"
      ],
      "verifiedAt": "ceeaf58 (HEAD, 2026-06-09)"
    },
    "codePatterns": [
      "oauth.service.ts:L31-L59 getAuthorizationUrl switch-case pattern"
    ],
    "gotchas": [
      "⚠️ x6dy spec previously claimed redirect_uri was correct — WRONG. Confirmed reversed segments at L40 and L54.",
      "⚠️ Do not change redirectBase env var — only the template suffix `/google/callback` → `/callback/google`"
    ],
    "modelTier": "fast",
    "modelTierReason": "2 files, single-line string changes, no cross-module dependencies, existing tests guide exact locations"
  },
  {
    "id": "axios-interceptor-and-refresh",
    "acs": [
      "AC2.1: 在 apps/web/src/api/index.ts 的 axios 实例上添加 request interceptor；从 localStorage 读取 'auth-storage' key，解析 JSON 提取 state.token；将 token 作为 Authorization: Bearer 头附加到每个请求；token 不存在时不附加头（guest 请求正常通过）；⚠ 不 import authStore（circular dep: authStore.ts:L9 imports from '../api'）",
      "AC2.2: 在 apps/web/src/api/index.ts 的 axios 实例上添加 response interceptor；当收到 401 响应时，从 localStorage 读取 state.refreshToken；调用 POST /auth/refresh（直接用 axios，不用 api 实例避免循环）；refresh 成功后将新 accessToken 写回 localStorage 的 state.token 字段，新 refreshToken 写回 state.refreshToken 字段；用新 token 重试原始失败请求；refresh 失败时清除 localStorage auth-storage 并重定向到登录页；同一时间只执行一次 refresh（并发 401 排队等待同一个 refresh Promise）",
      "AC2.3: 在 apps/web/src/api/index.ts 添加 refreshToken 函数（导出）；接受 refreshToken 参数，调用 POST /auth/refresh，返回 {accessToken, refreshToken}；使用独立 axios 调用（非 api 实例）避免 interceptor 递归；不 import authStore",
      "AC2.4: 在 apps/web/src/api/index.ts 为 response interceptor 添加 isRefreshing 标志和 failedQueue；当 isRefreshing=true 时新 401 请求入队等待；refresh 完成后批量 resolve 队列中的请求（用新 token 重试）；refresh 失败时批量 reject 队列",
      "AC2.5: 验证 interceptor 正确处理 localStorage zustand 持久化格式；key 为 'auth-storage'，value 为 JSON {state:{token,refreshToken,...},version:0}；token 从 state.token 读取，不从顶层读取"
    ],
    "files": [
      "apps/web/src/api/index.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. Read localStorage key 'auth-storage', JSON.parse, extract state.token. 2. Request interceptor: api.interceptors.request.use(config => { const stored = JSON.parse(localStorage.getItem('auth-storage') || '{}'); const token = stored?.state?.token; if (token) config.headers.Authorization = `Bearer ${token}`; return config; }). 3. Response interceptor with refresh queue: let isRefreshing = false; let failedQueue: Array<{resolve, reject}> = []; On 401 (not already retried): if isRefreshing → queue; else set isRefreshing=true, call refreshToken(stored.state.refreshToken), on success update localStorage + retry queued + retry original, on fail clear localStorage + window.location.href='/'. 4. Refresh function uses standalone axios.post(API_BASE + '/auth/refresh', {refreshToken}) — NOT the `api` instance. 5. POST /auth/refresh returns {accessToken, refreshToken, userId} (routes.ts:L189-193) — note field is 'accessToken' not 'token'. 6. Guard: skip refresh for auth endpoints themselves (login/register/guest-session/refresh) to avoid infinite loops.",
    "architectureContext": {
      "functions": [
        "api (axios instance) @ api/index.ts:L6",
        "authApi @ api/index.ts:L145 — consumers use this for auth calls",
        "authStore.setToken(token, refreshToken?) @ authStore.ts:L198",
        "authStore.getAuthHeader() @ authStore.ts:L192 — exists but NOT consumed by interceptor (we read localStorage directly)"
      ],
      "callChain": "any API consumer → api.get/post → request interceptor (attach token) → HTTP → response interceptor (catch 401) → refreshToken() → retry original",
      "imports": [
        "import axios from 'axios' (already imported at L2)",
        "const API_BASE = import.meta.env.VITE_API_URL || '/api/v1' (already defined at L5)"
      ],
      "typesInScope": [
        "Persisted auth-storage shape: { state: { token: string|null, refreshToken: string|null, user: User|null, session: Session|null, guestId: string|null }, version: number }",
        "POST /auth/refresh response: { accessToken: string, refreshToken: string, userId: string }"
      ],
      "testMock": [
        "const mockLocalStorage = { 'auth-storage': JSON.stringify({ state: { token: 'test-token', refreshToken: 'test-refresh' }, version: 0 }) }; Object.defineProperty(window, 'localStorage', { value: { getItem: (k) => mockLocalStorage[k] || null, setItem: vi.fn(), removeItem: vi.fn() } });",
        "vi.mock('axios', () => ({ default: { create: () => mockAxiosInstance, post: vi.fn() } }))"
      ],
      "dangerZones": [
        "authStore.ts:L9 imports from '../api' — interceptor MUST NOT import authStore (circular dependency)",
        "POST /auth/refresh returns {accessToken, refreshToken} — field name is 'accessToken' not 'token'",
        "Auth endpoints (login/register/guest-session/refresh) must NOT trigger 401 refresh logic (infinite loop)",
        "zustand persist key is 'auth-storage' — hardcoded string, not derived from store name"
      ],
      "verifiedAt": "ceeaf58 (HEAD, 2026-06-09)"
    },
    "codePatterns": [
      "authStore.ts:L203-212 zustand persist config — partialize shape reference",
      "routes.ts:L177-197 POST /refresh endpoint — response shape {accessToken, refreshToken, userId}",
      "authStore.ts:L192-196 getAuthHeader — token extraction pattern"
    ],
    "gotchas": [
      "⚠️ CRITICAL: authStore.ts:L9 `import { authApi } from '../api'` — interceptor MUST NOT import authStore. Read localStorage directly.",
      "⚠️ POST /auth/refresh returns `accessToken` not `token` — map accordingly when updating localStorage",
      "⚠️ Guard refresh logic against auth endpoints: /auth/login, /auth/register, /auth/guest-session, /auth/refresh — skip interceptor for these",
      "⚠️ Concurrent 401s: use single isRefreshing flag + queue pattern to avoid multiple simultaneous refresh calls",
      "⚠️ localStorage key 'auth-storage' is hardcoded in zustand persist config (authStore.ts:L204)"
    ],
    "modelTier": "standard",
    "modelTierReason": "1 file but non-trivial: interceptor with refresh queue, localStorage parsing, concurrent request handling, circular dep constraint"
  }
]
```

## Files

- apps/api/src/modules/auth/__tests__/oauth.service.test.ts
- apps/api/src/modules/auth/oauth.service.ts
- apps/web/src/api/index.ts