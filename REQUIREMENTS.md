# 需求
## 任务
## TDD 工作流

1. 读 AC → 写失败的测试
2. 运行测试确认失败
3. 最小实现让测试通过
4. 重构优化
5. 对所有 AC 重复
6. 运行 npm test + type check + lint
7. 更新 .progress.json（设置 allComplete: true 当且仅当所有 AC 满足）

完成后在 .progress.json 中记录：
- 做出的关键设计决策
- 需要跨步骤协调的事项

声明完成前必须：
1. 运行 npm test 确认所有测试通过（含你新增的测试）
2. 运行 npm run typecheck（或 tsc --noEmit）确认无类型错误
3. 将测试证据写入 .progress.json 的 testResults 字段
完成后在 .progress.json notes 中记录关键设计决策



## 验收标准
1. AC1.1: 在 oauth.service.ts L40；将 redirect_uri 模板从 `${redirectBase}/google/callback` 改为 `${redirectBase}/callback/google`；确保与路由 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数
2. AC1.2: 在 oauth.service.ts L54；将 redirect_uri 模板从 `${redirectBase}/github/callback` 改为 `${redirectBase}/callback/github`；确保与路由 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数
3. AC1.3: 在 oauth.service.test.ts 中更新 getAuthorizationUrl 测试；验证 redirect_uri 路径段顺序为 /callback/{provider} 而非 /{provider}/callback；保留现有其他断言不变

## 实现指南
1. oauth.service.ts L40: `${redirectBase}/google/callback` → `${redirectBase}/callback/google`. L54: `${redirectBase}/github/callback` → `${redirectBase}/callback/github`. 2. oauth.service.test.ts: find assertions on redirect_uri (likely L50-80 range), update expected path segment order. 3. No other files affected — oauth.routes.ts callback handler path is already /callback/:provider.

## 参考模式
- oauth.service.ts:L31-L59 getAuthorizationUrl switch-case pattern

## ⚠️ 注意事项
- ⚠️ x6dy spec previously claimed redirect_uri was correct — WRONG. Confirmed reversed segments at L40 and L54.
- ⚠️ Do not change redirectBase env var — only the template suffix `/google/callback` → `/callback/google`

## 预期改动文件
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts


## 你负责的验收标准
1. AC1.1: 在 oauth.service.ts L40；将 redirect_uri 模板从 `${redirectBase}/google/callback` 改为 `${redirectBase}/callback/google`；确保与路由 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数
2. AC1.2: 在 oauth.service.ts L54；将 redirect_uri 模板从 `${redirectBase}/github/callback` 改为 `${redirectBase}/callback/github`；确保与路由 GET /callback/:provider 路径一致；不修改 getAuthorizationUrl 的其他参数
3. AC1.3: 在 oauth.service.test.ts 中更新 getAuthorizationUrl 测试；验证 redirect_uri 路径段顺序为 /callback/{provider} 而非 /{provider}/callback；保留现有其他断言不变

## 架构上下文（Analyst 已探索并验证）

**下面的信息已经过 Analyst 代码探索验证。直接使用，不需要自己重新读文件。** 只在出现矛盾时才验证。

### 关键函数
- getAuthorizationUrl(provider: OAuthProvider, state: string): string @ oauth.service.ts:L31
- exchangeGoogleCode(code: string): Promise<OAuthTokens> @ oauth.service.ts:L82
- exchangeGitHubCode(code: string): Promise<OAuthTokens> @ oauth.service.ts:L143

### 调用链
oauth.routes.ts:GET /:provider → getAuthorizationUrl() → redirect to provider consent screen → provider redirects to GET /callback/:provider → exchangeCodeForTokens() → getOrCreateOAuthUser() → createOAuthSession()

### 需要导入
```import { generateRefreshToken, JWT_SECRET } from './service.js'```

### 相关类型
- OAuthProvider = 'google' | 'github' @ oauth.service.ts:L11
- OAuthProfile { provider, providerAccountId, email, name, avatar } @ oauth.service.ts:L13
- OAuthTokens { accessToken, refreshToken, expiresAt } @ oauth.service.ts:L21

### ⚠️ 禁区（不要触碰）
- L32 redirectBase defaults to 'http://localhost:3001/api/v1/auth' — correct base, only template suffix is wrong
- Do NOT change redirectBase env var or its default — only change the template suffix

*以上信息验证于 commit ceeaf58 (HEAD, 2026-06-09)*

## 实现指南
1. oauth.service.ts L40: `${redirectBase}/google/callback` → `${redirectBase}/callback/google`. L54: `${redirectBase}/github/callback` → `${redirectBase}/callback/github`. 2. oauth.service.test.ts: find assertions on redirect_uri (likely L50-80 range), update expected path segment order. 3. No other files affected — oauth.routes.ts callback handler path is already /callback/:provider.

## 参考模式
- oauth.service.ts:L31-L59 getAuthorizationUrl switch-case pattern

## ⚠️ 注意事项
- ⚠️ x6dy spec previously claimed redirect_uri was correct — WRONG. Confirmed reversed segments at L40 and L54.
- ⚠️ Do not change redirectBase env var — only the template suffix `/google/callback` → `/callback/google`

## 预期改动文件
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts

## 行为约束
- 完成前必须运行 npm test + type check + lint
- 禁止模糊声明完成
- 每完成一个步骤后立即更新 .progress.json
- 全部 AC 测试通过后才设置 .progress.json allComplete: true
- **Phase 3: 禁止创建新的 .test.ts / .spec.ts 文件**（测试由 Analyst + Reviewer 提供，你只实现代码让测试通过）
- 将测试证据写入 .progress.json.testResults: { passed, total, failed: 0, command: "npm test", evidence: "<测试输出>" }
- 将设计决策写入 .progress.json.designNotes: { decisions: ["选X不选Y因为Z"], failedAttempts: ["试过A遇到B问题"], uncertainties: ["C部分需要特别关注"], constraintsDiscovered: ["实现中发现AC未覆盖的限制D"] }
- designNotes 只记录对 Review 有意义的决策信息，不写琐碎细节� interceptor 正确处理 localStorage zustand 持久化格式；key 为 'auth-storage'，value 为 JSON {state:{token,refreshToken,...},version:0}；token 从 state.token 读取，不从顶层读取

## 架构上下文（Analyst 已探索并验证）

**下面的信息已经过 Analyst 代码探索验证。直接使用，不需要自己重新读文件。** 只在出现矛盾时才验证。

### 关键函数
- api (axios instance) @ api/index.ts:L6
- authApi @ api/index.ts:L145 — consumers use this for auth calls
- authStore.setToken(token, refreshToken?) @ authStore.ts:L198
- authStore.getAuthHeader() @ authStore.ts:L192 — exists but NOT consumed by interceptor (we read localStorage directly)

### 调用链
any API consumer → api.get/post → request interceptor (attach token) → HTTP → response interceptor (catch 401) → refreshToken() → retry original

### 需要导入
```import axios from 'axios' (already imported at L2)```
```const API_BASE = import.meta.env.VITE_API_URL || '/api/v1' (already defined at L5)```

### 相关类型
- Persisted auth-storage shape: { state: { token: string|null, refreshToken: string|null, user: User|null, session: Session|null, guestId: string|null }, version: number }
- POST /auth/refresh response: { accessToken: string, refreshToken: string, userId: string }

### ⚠️ 禁区（不要触碰）
- authStore.ts:L9 imports from '../api' — interceptor MUST NOT import authStore (circular dependency)
- POST /auth/refresh returns {accessToken, refreshToken} — field name is 'accessToken' not 'token'
- Auth endpoints (login/register/guest-session/refresh) must NOT trigger 401 refresh logic (infinite loop)
- zustand persist key is 'auth-storage' — hardcoded string, not derived from store name

### 测试 mock 模板
```typescript
const mockLocalStorage = { 'auth-storage': JSON.stringify({ state: { token: 'test-token', refreshToken: 'test-refresh' }, version: 0 }) }; Object.defineProperty(window, 'localStorage', { value: { getItem: (k) => mockLocalStorage[k] || null, setItem: vi.fn(), removeItem: vi.fn() } });
```
```typescript
vi.mock('axios', () => ({ default: { create: () => mockAxiosInstance, post: vi.fn() } }))
```

*以上信息验证于 commit ceeaf58 (HEAD, 2026-06-09)*

## 实现指南
1. Read localStorage key 'auth-storage', JSON.parse, extract state.token. 2. Request interceptor: api.interceptors.request.use(config => { const stored = JSON.parse(localStorage.getItem('auth-storage') || '{}'); const token = stored?.state?.token; if (token) config.headers.Authorization = `Bearer ${token}`; return config; }). 3. Response interceptor with refresh queue: let isRefreshing = false; let failedQueue: Array<{resolve, reject}> = []; On 401 (not already retried): if isRefreshing → queue; else set isRefreshing=true, call refreshToken(stored.state.refreshToken), on success update localStorage + retry queued + retry original, on fail clear localStorage + window.location.href='/'. 4. Refresh function uses standalone axios.post(API_BASE + '/auth/refresh', {refreshToken}) — NOT the `api` instance. 5. POST /auth/refresh returns {accessToken, refreshToken, userId} (routes.ts:L189-193) — note field is 'accessToken' not 'token'. 6. Guard: skip refresh for auth endpoints themselves (login/register/guest-session/refresh) to avoid infinite loops.

## 参考模式
- authStore.ts:L203-212 zustand persist config — partialize shape reference
- routes.ts:L177-197 POST /refresh endpoint — response shape {accessToken, refreshToken, userId}
- authStore.ts:L192-196 getAuthHeader — token extraction pattern

## ⚠️ 注意事项
- ⚠️ CRITICAL: authStore.ts:L9 `import { authApi } from '../api'` — interceptor MUST NOT import authStore. Read localStorage directly.
- ⚠️ POST /auth/refresh returns `accessToken` not `token` — map accordingly when updating localStorage
- ⚠️ Guard refresh logic against auth endpoints: /auth/login, /auth/register, /auth/guest-session, /auth/refresh — skip interceptor for these
- ⚠️ Concurrent 401s: use single isRefreshing flag + queue pattern to avoid multiple simultaneous refresh calls
- ⚠️ localStorage key 'auth-storage' is hardcoded in zustand persist config (authStore.ts:L204)

## 预期改动文件
- apps/web/src/api/index.ts

## 行为约束
- 完成前必须运行 npm test + type check + lint
- 禁止模糊声明完成
- 每完成一个步骤后立即更新 .progress.json
- 全部 AC 测试通过后才设置 .progress.json allComplete: true
- **Phase 3: 禁止创建新的 .test.ts / .spec.ts 文件**（测试由 Analyst + Reviewer 提供，你只实现代码让测试通过）
- 将测试证据写入 .progress.json.testResults: { passed, total, failed: 0, command: "npm test", evidence: "<测试输出>" }
- 将设计决策写入 .progress.json.designNotes: { decisions: ["选X不选Y因为Z"], failedAttempts: ["试过A遇到B问题"], uncertainties: ["C部分需要特别关注"], constraintsDiscovered: ["实现中发现AC未覆盖的限制D"] }
- designNotes 只记录对 Review 有意义的决策信息，不写琐碎细节