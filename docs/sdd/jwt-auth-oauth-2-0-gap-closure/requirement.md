---
id: "cmq6fxpse01jdqnnh50fohczd"
workUnitId: "cmq6fxun601k0qnnheezm8vle"
slug: "jwt-auth-oauth-2-0-gap-closure"
title: "JWT Auth + OAuth 2.0 Gap Closure"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "security", "bug-fix", "frontend-interceptor"]
createdAt: "2026-06-09T09:31:55.208Z"
updatedAt: "2026-06-09T09:32:02.078Z"
---

# JWT Auth + OAuth 2.0 Gap Closure

Fix 4 critical backend bugs (JWT payload mismatch, JWT_SECRET divergence, PUBLIC_API gap, OAuth redirect_uri mismatch) and add frontend auth interceptor + hash-based OAuth callback parsing

<!-- TASK_TIER {"tier":"standard","reason":"6 AC across 2 groups, 6 files, cross-module (backend auth + frontend api), no schema change"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["POST /auth/register — routes.ts L33, registered at /api/v1/auth via route-registry.ts:164","POST /auth/refresh — routes.ts L177, returns {accessToken, refreshToken, userId}","GET /auth/:provider — oauth.routes.ts L18, handles google|github","GET /auth/callback/:provider — oauth.routes.ts L43, handles google|github","optionalAuth() — middleware/auth.ts L97, parses Bearer token via verifyToken","requireAuth() — middleware/auth.ts L146, returns 401 on failure","verifyToken(token) — service.ts L82, reads payload.sid + payload.uid","generateToken(sessionId, userId?) — service.ts L75, signs {sid, uid}","createOAuthSession(userId, req) — oauth.service.ts L317, returns {token, refreshToken, session}","exchangeRefreshToken(token) — service.ts, returns {accessToken, refreshToken, userId} | null","cookieParser — app.ts L6, already in middleware chain","App.tsx L139 — /auth/callback bypasses guest wall for OAuthCallback","authStore.setToken(token, refreshToken?) — authStore.ts L198","authStore.checkAuth() — authStore.ts L102, calls authApi.checkAuth() then sets user"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ POST /auth/register — routes.ts L33, registered at /api/v1/auth via route-registry.ts:164
- ✅ POST /auth/refresh — routes.ts L177, returns {accessToken, refreshToken, userId}
- ✅ GET /auth/:provider — oauth.routes.ts L18, handles google|github
- ✅ GET /auth/callback/:provider — oauth.routes.ts L43, handles google|github
- ✅ optionalAuth() — middleware/auth.ts L97, parses Bearer token via verifyToken
- ✅ requireAuth() — middleware/auth.ts L146, returns 401 on failure
- ✅ verifyToken(token) — service.ts L82, reads payload.sid + payload.uid
- ✅ generateToken(sessionId, userId?) — service.ts L75, signs {sid, uid}
- ✅ createOAuthSession(userId, req) — oauth.service.ts L317, returns {token, refreshToken, session}
- ✅ exchangeRefreshToken(token) — service.ts, returns {accessToken, refreshToken, userId} | null
- ✅ cookieParser — app.ts L6, already in middleware chain
- ✅ App.tsx L139 — /auth/callback bypasses guest wall for OAuthCallback
- ✅ authStore.setToken(token, refreshToken?) — authStore.ts L198
- ✅ authStore.checkAuth() — authStore.ts L102, calls authApi.checkAuth() then sets user

## AC Groups

### backend-auth-bugs
<!-- MODEL_TIER {"tier":"standard","reason":"4 AC 跨 3 文件，涉及 JWT 签名一致性 + 环境变量统一 + 路由白名单 + OAuth redirect 修复，需要精确匹配现有模式"} -->

#### 验收标准
- [ ] AC1.1: 在 oauth.service.ts L334-L338；将 jwt.sign 的 payload 从 {sessionId, userId} 改为 {sid: session.id, uid: userId} 以匹配 service.ts L76 的 generateToken 签名和 middleware/auth.ts L84-L86 的 verifyToken 读取；不修改 service.ts 的 generateToken（已使用 sid/uid）
- [ ] AC1.2: 在 oauth.service.ts L27；将 JWT_SECRET 的 fallback 从 'dev-secret-change-me' 改为与 service.ts L13 一致的逻辑（production 抛错，非 production 用 'dev-jwt-secret-change-in-production'），或直接从 service.ts export JWT_SECRET 统一引用；不修改 service.ts L13 的 JWT_SECRET 定义
- [ ] AC1.3: 在 app.ts L78-L94 PUBLIC_API Set 中；添加 '/auth/register'、'/auth/github'、'/auth/callback/github'、'/auth/callback/google'（⚠ '/auth/google' 已存在 L83）；不删除现有条目
- [ ] AC1.4: 在 oauth.service.ts L33；将 OAUTH_REDIRECT_BASE 默认值从 'http://localhost:3001/api/v1/auth/oauth' 改为 'http://localhost:3001/api/v1/auth'，使生成的 callback URL 路径 .../auth/{provider}/callback 匹配 oauth.routes.ts L43 的路由定义；不修改 OAUTH_REDIRECT_BASE 环境变量的行为（用户仍可覆盖）

#### 涉及文件
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/service.ts
- apps/api/src/app.ts

### frontend-auth-interceptor
<!-- MODEL_TIER {"tier":"standard","reason":"3 AC 跨 3 文件（前端 api + 组件 + 后端 routes），涉及 localStorage 格式解析 + axios interceptor + URL fragment 迁移，需注意循环依赖和存储格式"} -->

#### 验收标准
- [ ] AC2.1: 在 apps/web/src/api/index.ts L10 后；添加 axios request interceptor，从 localStorage('auth-storage') 读取 persisted token 并附加 Authorization: Bearer header；⚠ 不 import authStore（authStore.ts L9 imports from '../api' 会造成循环依赖），直接读 localStorage JSON.parse 后取 token 字段
- [ ] AC2.2: 在 apps/web/src/api/index.ts；添加 axios response interceptor，当收到 401 且非 /auth/refresh 请求时，从 localStorage 读取 refreshToken 调用 POST /auth/refresh，成功后更新 localStorage 中的 token 并重试原请求；refresh 失败时清除 token 不自动跳转（由 authStore.checkAuth 处理降级）；不 import authStore
- [ ] AC2.3: 在 oauth.routes.ts L81；将 redirect 的 token 从 query string (?token=) 改为 URL fragment (#token=) 防止 Referer 泄漏；同步修改 OAuthCallback.tsx 从 useSearchParams() 改为解析 location.hash（new URLSearchParams(location.hash.substring(1))）；不修改 /auth/callback 路径（App.tsx L139 已处理此路径）

#### 涉及文件
- apps/web/src/api/index.ts
- apps/web/src/components/OAuthCallback.tsx
- apps/api/src/modules/auth/oauth.routes.ts

#### 依赖: backend-auth-bugs
## 约束
- 不修改 service.ts 的 generateToken/verifyToken 签名和行为（middleware/auth.ts 依赖）
- 不修改 middleware/auth.ts 的 optionalAuth/requireAuth（已正确使用 verifyToken）
- 不修改 App.tsx 的 /auth/callback 路径处理（L139-L146）
- 不引入 passport.js 或其他 OAuth 库（原生 fetch 方案已确定）
- authStore 不能被 api/index.ts import（循环依赖）
- OAuth tokens 必须使用 URL fragment（#）传递防止 Referer 泄漏
- JWT_SECRET 必须统一 — 两个 service 签出的 token 必须互相可验证

## AC Groups

```json
[
  {
    "id": "backend-auth-bugs",
    "acs": [
      "AC1.1: 在 oauth.service.ts L334-L338；将 jwt.sign 的 payload 从 {sessionId, userId} 改为 {sid: session.id, uid: userId} 以匹配 service.ts L76 的 generateToken 签名和 middleware/auth.ts L84-L86 的 verifyToken 读取；不修改 service.ts 的 generateToken（已使用 sid/uid）",
      "AC1.2: 在 oauth.service.ts L27；将 JWT_SECRET 的 fallback 从 'dev-secret-change-me' 改为与 service.ts L13 一致的逻辑（production 抛错，非 production 用 'dev-jwt-secret-change-in-production'），或直接从 service.ts export JWT_SECRET 统一引用；不修改 service.ts L13 的 JWT_SECRET 定义",
      "AC1.3: 在 app.ts L78-L94 PUBLIC_API Set 中；添加 '/auth/register'、'/auth/github'、'/auth/callback/github'、'/auth/callback/google'（⚠ '/auth/google' 已存在 L83）；不删除现有条目",
      "AC1.4: 在 oauth.service.ts L33；将 OAUTH_REDIRECT_BASE 默认值从 'http://localhost:3001/api/v1/auth/oauth' 改为 'http://localhost:3001/api/v1/auth'，使生成的 callback URL 路径 .../auth/{provider}/callback 匹配 oauth.routes.ts L43 的路由定义；不修改 OAUTH_REDIRECT_BASE 环境变量的行为（用户仍可覆盖）"
    ],
    "files": [
      "apps/api/src/modules/auth/oauth.service.ts",
      "apps/api/src/modules/auth/service.ts",
      "apps/api/src/app.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. oauth.service.ts L334: jwt.sign({sessionId, userId}, ...) → jwt.sign({sid: session.id, uid: userId}, ...). 2. oauth.service.ts L27: 统一 JWT_SECRET — 最简方案是从 service.ts export JWT_SECRET 并 import，避免两处定义分歧。需先确认 service.ts 是否 export JWT_SECRET（当前未 export，需添加 export 或在 oauth.service.ts 复制相同的 fallback 逻辑）。3. app.ts L78-L94: 在 PUBLIC_API Set 中添加缺失路径。4. oauth.service.ts L33: 改默认值。L41,L55 的 redirect_uri 模板 `${base}/${provider}/callback` 会自动生成正确的 .../auth/google/callback。",
    "architectureContext": {
      "functions": [
        "createOAuthSession(userId: string, req: {ip?: string; headers: Record<string, string|undefined>}): Promise<{token: string; refreshToken: string; session: {id: string; expiresAt: Date}}> @ oauth.service.ts:L317-L354",
        "generateToken(sessionId: string, userId?: string): string @ service.ts:L75-L77 — signs {sid: sessionId, uid: userId}",
        "verifyToken(token: string): {sessionId: string; userId?: string} | null @ service.ts:L82-L92 — reads payload.sid, payload.uid",
        "getAuthorizationUrl(provider: OAuthProvider, state: string): string @ oauth.service.ts:L32-L78 — builds OAuth consent URL with redirect_uri"
      ],
      "callChain": "OAuth callback → oauth.routes.ts:callback handler → oauthService.createOAuthSession() → jwt.sign({sid, uid}) → redirect to frontend → middleware/auth.ts verifyToken reads payload.sid/uid",
      "imports": [
        "import jwt from 'jsonwebtoken' @ oauth.service.ts:L7",
        "import { generateRefreshToken } from './service.js' @ oauth.service.ts:L9"
      ],
      "typesInScope": [
        "OAuthProvider = 'google' | 'github' @ oauth.service.ts:L11",
        "OAuthProfile { provider: OAuthProvider; providerAccountId: string; email: string; name: string|null; avatar: string|null } @ oauth.service.ts:L13-L19",
        "OAuthTokens { accessToken: string; refreshToken: string|null; expiresAt: Date|null } @ oauth.service.ts:L21-L25"
      ],
      "testMock": [
        "vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('mock-jwt') }, sign: vi.fn().mockReturnValue('mock-jwt') }))",
        "vi.mock('@dommaker/studio-prisma', () => ({ prisma: { session: { create: vi.fn(), update: vi.fn() }, refreshToken: { create: vi.fn() } } }))"
      ],
      "dangerZones": [
        "oauth.service.ts L27: JWT_SECRET — 改动此行会影响所有 OAuth token 签名，必须确保与 service.ts L13 使用相同 secret",
        "service.ts L13: JWT_SECRET — production 环境抛错逻辑不能被破坏",
        "oauth.service.ts L41,L55: redirect_uri 模板 `${base}/${provider}/callback` — 只改 L33 的默认值，不改模板",
        "app.ts L77: PUBLIC_API 只在 NODE_ENV=production 时生效，dev/test 跳过此检查",
        "oauth.service.ts L347: generateRefreshToken(userId) — 依赖 service.ts export，不要破坏此 import"
      ],
      "verifiedAt": "working tree @ 1c4bb9a base"
    },
    "codePatterns": [
      "service.ts:L75-L77 — canonical JWT sign: jwt.sign({ sid: sessionId, uid: userId }, JWT_SECRET, { expiresIn })",
      "service.ts:L82-L92 — canonical JWT verify: jwt.verify → { sessionId: payload.sid, userId: payload.uid }",
      "oauth.service.ts:L334-L338 — current (broken) JWT sign: jwt.sign({ sessionId, userId }, ...) → must match service.ts pattern"
    ],
    "gotchas": [
      "⚠️ oauth.service.ts L27 JWT_SECRET fallback 'dev-secret-change-me' ≠ service.ts L13 'dev-jwt-secret-change-in-production' — 如果不统一，两个 service 签出的 token 互相无法验证",
      "⚠️ oauth.service.ts L334 改动后必须同步验证 middleware/auth.ts L84-L86 的 verifyToken 能正确读取 payload.sid/uid",
      "⚠️ app.ts PUBLIC_API 只在 production 生效 — 改动后需要在 production-like 环境验证",
      "⚠️ OAuth redirect_uri 改动后需验证 Google/GitHub OAuth 应用配置中的 callback URL 与新值匹配"
    ],
    "modelTier": "standard",
    "modelTierReason": "4 AC 跨 3 文件，涉及 JWT 签名一致性 + 环境变量统一 + 路由白名单 + OAuth redirect 修复，需要精确匹配现有模式"
  },
  {
    "id": "frontend-auth-interceptor",
    "acs": [
      "AC2.1: 在 apps/web/src/api/index.ts L10 后；添加 axios request interceptor，从 localStorage('auth-storage') 读取 persisted token 并附加 Authorization: Bearer header；⚠ 不 import authStore（authStore.ts L9 imports from '../api' 会造成循环依赖），直接读 localStorage JSON.parse 后取 token 字段",
      "AC2.2: 在 apps/web/src/api/index.ts；添加 axios response interceptor，当收到 401 且非 /auth/refresh 请求时，从 localStorage 读取 refreshToken 调用 POST /auth/refresh，成功后更新 localStorage 中的 token 并重试原请求；refresh 失败时清除 token 不自动跳转（由 authStore.checkAuth 处理降级）；不 import authStore",
      "AC2.3: 在 oauth.routes.ts L81；将 redirect 的 token 从 query string (?token=) 改为 URL fragment (#token=) 防止 Referer 泄漏；同步修改 OAuthCallback.tsx 从 useSearchParams() 改为解析 location.hash（new URLSearchParams(location.hash.substring(1))）；不修改 /auth/callback 路径（App.tsx L139 已处理此路径）"
    ],
    "files": [
      "apps/web/src/api/index.ts",
      "apps/web/src/components/OAuthCallback.tsx",
      "apps/api/src/modules/auth/oauth.routes.ts"
    ],
    "dependencies": [
      "backend-auth-bugs"
    ],
    "implementationNotes": "1. api/index.ts: 在 axios.create() 后添加 api.interceptors.request.use(config => { const raw = localStorage.getItem('auth-storage'); if (raw) { const { state } = JSON.parse(raw); if (state?.token) config.headers.Authorization = `Bearer ${state.token}`; } return config; }). zustand persist 默认 key 是 'auth-storage'，存储格式为 {state: {token, refreshToken, ...}, version: 0}。2. api/index.ts response interceptor: 401 → check if already refreshing (flag) → POST /auth/refresh with refreshToken → update localStorage → retry. 注意 POST /auth/refresh 返回 {accessToken, refreshToken} 不是 {token, refreshToken}。3. oauth.routes.ts L81: `${FRONTEND_URL}/auth/callback?${params}` → `${FRONTEND_URL}/auth/callback#${params}`. 4. OAuthCallback.tsx: useSearchParams() → new URLSearchParams(location.hash.substring(1)).",
    "architectureContext": {
      "functions": [
        "api (axios instance) @ api/index.ts:L6-L10 — baseURL = '/api/v1', withCredentials: true",
        "authApi.getOAuthUrl(provider) @ api/index.ts:L156-L157 — returns `${API_BASE}/auth/${provider}`",
        "OAuthCallback() @ OAuthCallback.tsx:L10-L44 — reads searchParams, calls setToken + checkAuth",
        "setToken(token, refreshToken?) @ authStore.ts:L198-L199 — sets token + optional refreshToken",
        "checkAuth() @ authStore.ts:L102-L120 — calls authApi.checkAuth(), sets user or falls back to guest"
      ],
      "callChain": "AuthModal handleOAuth() → window.location.href = authApi.getOAuthUrl(provider) → OAuth provider → oauth.routes.ts callback → createOAuthSession → redirect to /auth/callback#token=xxx → OAuthCallback reads hash → setToken → checkAuth → navigate /channels",
      "imports": [
        "import axios from 'axios' @ api/index.ts:L2",
        "import { useAuthStore } from '../stores/authStore' @ OAuthCallback.tsx:L3",
        "import { useNavigate, useSearchParams } from 'react-router-dom' @ OAuthCallback.tsx:L2 (需改为 useNavigate + useEffect + location.hash)"
      ],
      "typesInScope": [
        "AuthState { token: string|null; refreshToken: string|null; user: User|null; ... } @ authStore.ts:L25-L51",
        "zustand persist storage key: 'auth-storage' @ authStore.ts:L204",
        "persisted shape: { state: { token, refreshToken, user, session, guestId }, version: number }"
      ],
      "testMock": [
        "const mockLocalStorage = { 'auth-storage': JSON.stringify({ state: { token: 'test-token', refreshToken: 'test-refresh' }, version: 0 }) }; vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => mockLocalStorage[key] || null)"
      ],
      "dangerZones": [
        "api/index.ts: 不能 import authStore — authStore.ts L9 imports from '../api' 造成循环依赖",
        "OAuthCallback.tsx: useSearchParams 依赖 react-router-dom — 改为 location.hash 后仍需 useEffect + navigate",
        "auth-storage 格式: zustand persist 默认包一层 {state, version} — 读 token 要 JSON.parse(raw).state.token",
        "POST /auth/refresh 返回 {accessToken, refreshToken} — 不是 {token, refreshToken}",
        "oauth.routes.ts L81: fragment 方式下 OAuth error 也要用 # 传递（如 /auth/callback#error=xxx）"
      ],
      "verifiedAt": "working tree @ 1c4bb9a base"
    },
    "codePatterns": [
      "oauth.routes.ts:L76-L81 — current redirect (needs fragment fix): res.redirect(`${FRONTEND_URL}/auth/callback?${params}`)",
      "OAuthCallback.tsx:L11 — current (needs hash): const [searchParams] = useSearchParams()",
      "authStore.ts:L204-L211 — zustand persist config: name: 'auth-storage', partialize"
    ],
    "gotchas": [
      "⚠️ zustand persist 存储格式是 {state: {...}, version: 0}，不是扁平的 {token: ...} — localStorage.getItem 后要 .state.token",
      "⚠️ POST /auth/refresh 返回 {accessToken, refreshToken} 不是 {token, refreshToken} — 更新 localStorage 时用 accessToken 作为 token",
      "⚠️ interceptor 重试原请求时要防止无限循环（refresh 请求本身 401 不再 refresh）",
      "⚠️ OAuthCallback 改为 hash 解析后，error 参数也要从 hash 读（oauth.routes.ts L53,L59 的 error redirect 也要用 #）"
    ],
    "modelTier": "standard",
    "modelTierReason": "3 AC 跨 3 文件（前端 api + 组件 + 后端 routes），涉及 localStorage 格式解析 + axios interceptor + URL fragment 迁移，需注意循环依赖和存储格式"
  }
]
```

## Files

- apps/api/src/app.ts
- apps/api/src/modules/auth/oauth.routes.ts
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/service.ts
- apps/web/src/api/index.ts
- apps/web/src/components/OAuthCallback.tsx