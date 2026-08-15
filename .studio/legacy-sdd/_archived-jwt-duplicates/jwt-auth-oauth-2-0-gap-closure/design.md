---
id: "cmq6fxpse01jdqnnh50fohczd"
goalId: "cmq6fxun601k0qnnheezm8vle"
slug: "jwt-auth-oauth-2-0-gap-closure"
title: "JWT Auth + OAuth 2.0 Gap Closure"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "security", "bug-fix", "frontend-interceptor"]
createdAt: "2026-06-09T09:31:55.208Z"
updatedAt: "2026-06-09T09:32:02.078Z"
---

# JWT Auth + OAuth 2.0 Gap Closure

Fix 4 critical backend bugs (JWT payload mismatch, JWT_SECRET divergence, PUBLIC_API gap, OAuth redirect_uri mismatch) and add frontend auth interceptor + hash-based OAuth callback parsing

<!-- TASK_TIER {"tier":"standard","reason":"6 AC across 2 groups, 6 files, cross-module (backend auth + frontend api), no schema change"} -->

## Architecture Context

### backend-auth-bugs

**Functions**
- createOAuthSession(userId: string, req: {ip?: string; headers: Record<string, string|undefined>}): Promise<{token: string; refreshToken: string; session: {id: string; expiresAt: Date}}> @ oauth.service.ts:L317-L354
- generateToken(sessionId: string, userId?: string): string @ service.ts:L75-L77 — signs {sid: sessionId, uid: userId}
- verifyToken(token: string): {sessionId: string; userId?: string} | null @ service.ts:L82-L92 — reads payload.sid, payload.uid
- getAuthorizationUrl(provider: OAuthProvider, state: string): string @ oauth.service.ts:L32-L78 — builds OAuth consent URL with redirect_uri

**Call Chain**
OAuth callback → oauth.routes.ts:callback handler → oauthService.createOAuthSession() → jwt.sign({sid, uid}) → redirect to frontend → middleware/auth.ts verifyToken reads payload.sid/uid

**Imports**
- import jwt from 'jsonwebtoken' @ oauth.service.ts:L7
- import { generateRefreshToken } from './service.js' @ oauth.service.ts:L9

**Types in Scope**
- OAuthProvider = 'google' | 'github' @ oauth.service.ts:L11
- OAuthProfile { provider: OAuthProvider; providerAccountId: string; email: string; name: string|null; avatar: string|null } @ oauth.service.ts:L13-L19
- OAuthTokens { accessToken: string; refreshToken: string|null; expiresAt: Date|null } @ oauth.service.ts:L21-L25

**Test Mocks**
- vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('mock-jwt') }, sign: vi.fn().mockReturnValue('mock-jwt') }))
- vi.mock('@dommaker/studio-prisma', () => ({ prisma: { session: { create: vi.fn(), update: vi.fn() }, refreshToken: { create: vi.fn() } } }))

**Danger Zones**
- oauth.service.ts L27: JWT_SECRET — 改动此行会影响所有 OAuth token 签名，必须确保与 service.ts L13 使用相同 secret
- service.ts L13: JWT_SECRET — production 环境抛错逻辑不能被破坏
- oauth.service.ts L41,L55: redirect_uri 模板 `${base}/${provider}/callback` — 只改 L33 的默认值，不改模板
- app.ts L77: PUBLIC_API 只在 NODE_ENV=production 时生效，dev/test 跳过此检查
- oauth.service.ts L347: generateRefreshToken(userId) — 依赖 service.ts export，不要破坏此 import

### frontend-auth-interceptor

**Functions**
- api (axios instance) @ api/index.ts:L6-L10 — baseURL = '/api/v1', withCredentials: true
- authApi.getOAuthUrl(provider) @ api/index.ts:L156-L157 — returns `${API_BASE}/auth/${provider}`
- OAuthCallback() @ OAuthCallback.tsx:L10-L44 — reads searchParams, calls setToken + checkAuth
- setToken(token, refreshToken?) @ authStore.ts:L198-L199 — sets token + optional refreshToken
- checkAuth() @ authStore.ts:L102-L120 — calls authApi.checkAuth(), sets user or falls back to guest

**Call Chain**
AuthModal handleOAuth() → window.location.href = authApi.getOAuthUrl(provider) → OAuth provider → oauth.routes.ts callback → createOAuthSession → redirect to /auth/callback#token=xxx → OAuthCallback reads hash → setToken → checkAuth → navigate /channels

**Imports**
- import axios from 'axios' @ api/index.ts:L2
- import { useAuthStore } from '../stores/authStore' @ OAuthCallback.tsx:L3
- import { useNavigate, useSearchParams } from 'react-router-dom' @ OAuthCallback.tsx:L2 (需改为 useNavigate + useEffect + location.hash)

**Types in Scope**
- AuthState { token: string|null; refreshToken: string|null; user: User|null; ... } @ authStore.ts:L25-L51
- zustand persist storage key: 'auth-storage' @ authStore.ts:L204
- persisted shape: { state: { token, refreshToken, user, session, guestId }, version: number }

**Test Mocks**
- const mockLocalStorage = { 'auth-storage': JSON.stringify({ state: { token: 'test-token', refreshToken: 'test-refresh' }, version: 0 }) }; vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => mockLocalStorage[key] || null)

**Danger Zones**
- api/index.ts: 不能 import authStore — authStore.ts L9 imports from '../api' 造成循环依赖
- OAuthCallback.tsx: useSearchParams 依赖 react-router-dom — 改为 location.hash 后仍需 useEffect + navigate
- auth-storage 格式: zustand persist 默认包一层 {state, version} — 读 token 要 JSON.parse(raw).state.token
- POST /auth/refresh 返回 {accessToken, refreshToken} — 不是 {token, refreshToken}
- oauth.routes.ts L81: fragment 方式下 OAuth error 也要用 # 传递（如 /auth/callback#error=xxx）

## AC Groups

### backend-auth-bugs

#### 实现指南
1. oauth.service.ts L334: jwt.sign({sessionId, userId}, ...) → jwt.sign({sid: session.id, uid: userId}, ...). 2. oauth.service.ts L27: 统一 JWT_SECRET — 最简方案是从 service.ts export JWT_SECRET 并 import，避免两处定义分歧。需先确认 service.ts 是否 export JWT_SECRET（当前未 export，需添加 export 或在 oauth.service.ts 复制相同的 fallback 逻辑）。3. app.ts L78-L94: 在 PUBLIC_API Set 中添加缺失路径。4. oauth.service.ts L33: 改默认值。L41,L55 的 redirect_uri 模板 `${base}/${provider}/callback` 会自动生成正确的 .../auth/google/callback。

#### 参考模式
- service.ts:L75-L77 — canonical JWT sign: jwt.sign({ sid: sessionId, uid: userId }, JWT_SECRET, { expiresIn })
- service.ts:L82-L92 — canonical JWT verify: jwt.verify → { sessionId: payload.sid, userId: payload.uid }
- oauth.service.ts:L334-L338 — current (broken) JWT sign: jwt.sign({ sessionId, userId }, ...) → must match service.ts pattern

#### ⚠️ 注意事项
- ⚠️ oauth.service.ts L27 JWT_SECRET fallback 'dev-secret-change-me' ≠ service.ts L13 'dev-jwt-secret-change-in-production' — 如果不统一，两个 service 签出的 token 互相无法验证
- ⚠️ oauth.service.ts L334 改动后必须同步验证 middleware/auth.ts L84-L86 的 verifyToken 能正确读取 payload.sid/uid
- ⚠️ app.ts PUBLIC_API 只在 production 生效 — 改动后需要在 production-like 环境验证
- ⚠️ OAuth redirect_uri 改动后需验证 Google/GitHub OAuth 应用配置中的 callback URL 与新值匹配

### frontend-auth-interceptor

#### 实现指南
1. api/index.ts: 在 axios.create() 后添加 api.interceptors.request.use(config => { const raw = localStorage.getItem('auth-storage'); if (raw) { const { state } = JSON.parse(raw); if (state?.token) config.headers.Authorization = `Bearer ${state.token}`; } return config; }). zustand persist 默认 key 是 'auth-storage'，存储格式为 {state: {token, refreshToken, ...}, version: 0}。2. api/index.ts response interceptor: 401 → check if already refreshing (flag) → POST /auth/refresh with refreshToken → update localStorage → retry. 注意 POST /auth/refresh 返回 {accessToken, refreshToken} 不是 {token, refreshToken}。3. oauth.routes.ts L81: `${FRONTEND_URL}/auth/callback?${params}` → `${FRONTEND_URL}/auth/callback#${params}`. 4. OAuthCallback.tsx: useSearchParams() → new URLSearchParams(location.hash.substring(1)).

#### 参考模式
- oauth.routes.ts:L76-L81 — current redirect (needs fragment fix): res.redirect(`${FRONTEND_URL}/auth/callback?${params}`)
- OAuthCallback.tsx:L11 — current (needs hash): const [searchParams] = useSearchParams()
- authStore.ts:L204-L211 — zustand persist config: name: 'auth-storage', partialize

#### ⚠️ 注意事项
- ⚠️ zustand persist 存储格式是 {state: {...}, version: 0}，不是扁平的 {token: ...} — localStorage.getItem 后要 .state.token
- ⚠️ POST /auth/refresh 返回 {accessToken, refreshToken} 不是 {token, refreshToken} — 更新 localStorage 时用 accessToken 作为 token
- ⚠️ interceptor 重试原请求时要防止无限循环（refresh 请求本身 401 不再 refresh）
- ⚠️ OAuthCallback 改为 hash 解析后，error 参数也要从 hash 读（oauth.routes.ts L53,L59 的 error redirect 也要用 #）