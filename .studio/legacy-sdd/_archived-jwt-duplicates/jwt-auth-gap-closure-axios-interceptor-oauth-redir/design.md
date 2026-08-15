---
id: "cmq6k1npf0022eeiwvvmwkr2o"
goalId: "cmq6k1qgo002geeiwynmbkhd9"
slug: "jwt-auth-gap-closure-axios-interceptor-oauth-redir"
title: "JWT Auth Gap Closure: Axios Interceptor + OAuth Redirect Fix"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "security", "axios", "jwt", "oauth", "interceptor", "frontend", "backend"]
createdAt: "2026-06-09T11:26:57.601Z"
updatedAt: "2026-06-09T11:27:01.272Z"
---

# JWT Auth Gap Closure: Axios Interceptor + OAuth Redirect Fix

Complete the remaining gaps in the JWT auth system: add axios interceptors so all frontend consumers send Bearer tokens and handle refresh, fix OAuth redirect_uri path reversal, and migrate OAuth token delivery from query params to URL fragments.

<!-- TASK_TIER {"tier":"premium","reason":"3 AC groups spanning frontend interceptor (48+ consumers), backend OAuth redirect fix, and frontend+backend OAuth fragment migration. Cross-module changes with circular dependency constraints."} -->

## Architecture Context

### axios-interceptor

**Functions**
- axios.create(config) → AxiosInstance — api/index.ts:L6
- axios.interceptors.request.use(onFulfilled, onRejected) — injects headers
- axios.interceptors.response.use(onFulfilled, onRejected) — handles 401
- exchangeRefreshToken(refreshToken: string) → { accessToken, refreshToken, userId } | null — service.ts:L321

**Call Chain**
Frontend API call → request interceptor (inject Bearer) → backend requireAuth → parseAuthHeader → verifyToken → prisma.session.findUnique. On 401 → response interceptor → POST /auth/refresh → exchangeRefreshToken → retry original request.

**Imports**
- import axios from 'axios' (already imported at api/index.ts:L2)
- NO import of authStore (circular dependency: authStore.ts:L9 imports from '../api')

**Types in Scope**
- AxiosRequestConfig { headers?: Record<string, string>, baseURL?: string, ... }
- AxiosResponse { data: unknown, status: number, ... }
- AxiosError { config: AxiosRequestConfig, response?: AxiosResponse }
- auth-storage localStorage shape: { state: { token: string|null, refreshToken: string|null, user: User|null, session: Session|null, guestId: string|null }, version: number }

**Test Mocks**
- vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() })
- vi.mock('axios', () => ({ default: { create: vi.fn().mockReturnValue({ interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } }, get: vi.fn(), post: vi.fn() }) } }))

**Danger Zones**
- L9 withCredentials: true — keep it (needed for cookie-based OAuth CSRF flow)
- L5 API_BASE — don't change, used by authApi.getOAuthUrl at L157
- authApi at L145-L158 — checkAuth calls /auth/me which will 401 for guests (optionalAuth handles this, interceptor must not treat /auth/me 401 as refresh trigger — it's in the exclusion list)
- POST /auth/refresh returns { accessToken, refreshToken } not { token, refreshToken } — use accessToken for localStorage update

### oauth-redirect-fix

**Functions**
- getAuthorizationUrl(provider: OAuthProvider, state: string) → string @ oauth.service.ts:L31
- oauth.routes.ts callback route: GET /callback/:provider @ L43

**Call Chain**
AuthModal handleOAuth → window.location.href = /api/v1/auth/:provider → oauth.routes GET /:provider → getAuthorizationUrl → redirect to Google/GitHub → callback to /api/v1/auth/callback/:provider → exchangeCodeForTokens → getOrCreateOAuthUser → createOAuthSession → redirect to frontend

**Imports**
- import jwt from 'jsonwebtoken' (already imported at L7)
- import { generateRefreshToken, JWT_SECRET } from './service.js' (already imported at L9)

**Types in Scope**
- OAuthProvider = 'google' | 'github' @ oauth.service.ts:L11
- OAuthProfile { provider, providerAccountId, email, name?, avatar? } @ oauth.service.ts:L13-L19

**Test Mocks**
- vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('mock-jwt-token') } }))
- vi.mock('@dommaker/studio-prisma', () => ({ prisma: { session: { create: vi.fn(), update: vi.fn() }, user: { findUnique: vi.fn() }, oAuthAccount: { findUnique: vi.fn(), upsert: vi.fn() }, refreshToken: { create: vi.fn() } } }))

**Danger Zones**
- L32 OAUTH_REDIRECT_BASE — used at L40 (Google) and L54 (GitHub), both must use consistent base
- L40, L54 redirect_uri templates — must produce path matching oauth.routes.ts L43 /callback/:provider
- oauth.service.test.ts getAuthorizationUrl test — will need redirect_uri assertion updated after fix

### oauth-token-fragment

**Functions**
- oauth.routes.ts callback handler @ L43-L86 — builds redirect URL
- OAuthCallback() component @ OAuthCallback.tsx:L10 — parses token from URL

**Call Chain**
OAuth provider callback → oauth.routes.ts handler → exchange code → create session → redirect to frontend with #token=... → OAuthCallback parses hash → setToken → checkAuth → navigate

**Imports**
- oauth.routes: no new imports needed
- OAuthCallback: import { useNavigate } from 'react-router-dom' (already imported), remove useSearchParams if no longer needed

**Types in Scope**
- URLSearchParams — standard Web API for parsing query/fragment strings
- window.location.hash — string starting with '#'

**Test Mocks**
- vi.mock('react-router-dom', () => ({ useNavigate: vi.fn().mockReturnValue(vi.fn()), useSearchParams: vi.fn().mockReturnValue([new URLSearchParams()]) }))
- vi.mock('../stores/authStore', () => ({ useAuthStore: vi.fn().mockReturnValue({ setToken: vi.fn(), checkAuth: vi.fn().mockResolvedValue(undefined) }) }))

**Danger Zones**
- L53 error redirect uses query params — keep as query (error is not sensitive, and browser may not preserve fragment on redirect)
- L84 error redirect same — keep as query
- OAuthCallback must handle BOTH: error in query params (searchParams) AND tokens in fragment (hash)

## AC Groups

### axios-interceptor

#### 实现指南
1. 添加 request interceptor：读 localStorage 'auth-storage'，JSON.parse 取 state.token，存在则设 config.headers.Authorization = `Bearer ${token}`。2. 添加 response interceptor：onError 中判断 401 + 非 auth 路径 → POST /auth/refresh（用独立 axios 实例避免循环） → 成功则更新 localStorage + 重试原请求。3. 约束：不 import authStore，直接读 localStorage（避免 circular dependency）。4. Refresh 路径排除列表：/auth/login, /auth/register, /auth/guest-session, /auth/refresh, /auth/me。5. POST /auth/refresh 返回 { accessToken, refreshToken }（不是 { token, refreshToken }）。6. 401 处理：refresh 成功 → 用新 token 重试原请求（更新 Authorization header）；refresh 失败 → localStorage.removeItem('auth-storage') + window.location.href = '/'。

#### 参考模式
- 参考 authStore.ts:L192-L196 getAuthHeader() 实现 — 同样的 Bearer token 格式
- 参考 DeleteButton.tsx:L75-L80 — 唯一正确发送 auth 的组件（raw fetch + getAuthHeader）
- 参考 auth-flow.e2e.test.ts:L6-L21 — e2e 测试中的 auth header 注入模式

#### ⚠️ 注意事项
- ⚠️ 不可 import authStore（authStore.ts:L9 imports from '../api' → 循环依赖）— 必须直接读 localStorage
- ⚠️ localStorage shape: Zustand persist 格式 { state: { token, refreshToken, ... }, version: 0 } — 不是扁平结构
- ⚠️ /auth/me 返回 401 对 guest 用户是正常的（optionalAuth 不阻塞）— interceptor 不应触发 refresh
- ⚠️ Refresh 失败后必须清除 localStorage 并重定向 — 否则用户卡在已过期 token 的状态
- ⚠️ POST /auth/refresh 返回 { accessToken, refreshToken } — 不是 { token, refreshToken }

### oauth-redirect-fix

#### 实现指南
1. oauth.service.ts L40: `${redirectBase}/google/callback` → `${redirectBase}/callback/google`。2. oauth.service.ts L54: `${redirectBase}/github/callback` → `${redirectBase}/callback/github`。3. 更新测试中断言 redirect_uri 包含正确的路径段顺序。4. redirectBase 默认值 'http://localhost:3001/api/v1/auth' 不变——问题在模板拼接顺序，不在 base。

#### 参考模式
- 参考 oauth.routes.ts:L43 — callback 路由路径 GET /callback/:provider
- 参考 oauth.routes.ts:L18 — OAuth 启动路由 GET /:provider

#### ⚠️ 注意事项
- ⚠️ redirect_uri 拼接逻辑：redirectBase + '/' + provider + '/callback' 当前产生 .../auth/google/callback，但路由是 .../auth/callback/google — 段顺序不同
- ⚠️ oauth.service.test.ts 的 getAuthorizationUrl 测试会断言 redirect_uri — 修改后需同步更新测试
- ⚠️ 不改 redirectBase 默认值——问题在模板拼接顺序，不在 base

### oauth-token-fragment

#### 实现指南
1. oauth.routes.ts L81: `${FRONTEND_URL}/auth/callback?${params}` → `${FRONTEND_URL}/auth/callback#${params}`。注意 L53 和 L84 的 error redirect 保持 query params（error 不敏感）。2. OAuthCallback.tsx: 移除 useSearchParams，改用 new URLSearchParams(window.location.hash.substring(1)) 解析 fragment。3. 错误处理：error 仍在 query params（L53, L84），OAuthCallback.tsx 需同时检查 searchParams 和 hash。4. 安全：fragment 不发送到服务器（RFC 7231），Referer header 不包含 fragment。

#### 参考模式
- 参考 OAuthCallback.tsx:L11 useSearchParams — 当前 query params 解析模式
- 参考 oauth.routes.ts:L76-L80 URLSearchParams 构建 — 只改 ? → #

#### ⚠️ 注意事项
- ⚠️ Error redirects (L53, L84) 保持 query params — error 不敏感，且 fragment 在 redirect 时可能丢失
- ⚠️ OAuthCallback 需同时检查 searchParams（error）和 hash（token）—— 不能只看一个
- ⚠️ window.location.hash 包含前缀 '#' — 解析时需 substring(1)
- ⚠️ 浏览器兼容：URLSearchParams 在所有现代浏览器可用，但需确认目标浏览器支持