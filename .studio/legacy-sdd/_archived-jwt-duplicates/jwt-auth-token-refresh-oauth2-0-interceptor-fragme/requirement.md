---
id: "cmq6i4znn01z6qnnhczsy0pm5"
workUnitId: "cmq6i53h401zfqnnhgmkc292v"
slug: "jwt-auth-token-refresh-oauth2-0-interceptor-fragme"
title: "JWT Auth + Token Refresh + OAuth2.0 — 剩余缺口闭合 (Interceptor + Fragment Security)"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "interceptor", "security", "frontend", "backend"]
createdAt: "2026-06-09T10:33:33.819Z"
updatedAt: "2026-06-09T10:33:38.860Z"
---

# JWT Auth + Token Refresh + OAuth2.0 — 剩余缺口闭合 (Interceptor + Fragment Security)

Backend JWT/OAuth/Refresh 全部完成 (32/32 tests)。剩余缺口：(1) 前端 axios interceptor 注入 Bearer + 401 自动刷新，(2) OAuth token URL fragment 安全修复。

<!-- TASK_TIER {"tier":"standard","reason":"2 AC 组，3 文件，无 schema 变更，无新模块。interceptor 逻辑复杂（并发队列 + 循环依赖规避）但不涉及架构决策。"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["POST /auth/refresh — routes.ts:L177, 返回 {accessToken, refreshToken, userId}","GET /auth/me — routes.ts:L146, optionalAuth(), 返回 {user, session}","authStore persist key 'auth-storage' — authStore.ts:L204, partialize 含 token+refreshToken","OAuth redirect — oauth.routes.ts:L81, 当前用 query params (代码与注释矛盾：L75 注释说 fragment 但 L81 用 '?')","OAuthCallback — OAuthCallback.tsx:L11, 用 useSearchParams() 读 query params","JWT expiry — oauth.service.ts:L320 已是 7 天, L336 已是 '7d' (已完成，无需改动)"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ POST /auth/refresh — routes.ts:L177, 返回 {accessToken, refreshToken, userId}
- ✅ GET /auth/me — routes.ts:L146, optionalAuth(), 返回 {user, session}
- ✅ authStore persist key 'auth-storage' — authStore.ts:L204, partialize 含 token+refreshToken
- ✅ OAuth redirect — oauth.routes.ts:L81, 当前用 query params (代码与注释矛盾：L75 注释说 fragment 但 L81 用 '?')
- ✅ OAuthCallback — OAuthCallback.tsx:L11, 用 useSearchParams() 读 query params
- ✅ JWT expiry — oauth.service.ts:L320 已是 7 天, L336 已是 '7d' (已完成，无需改动)

## AC Groups

### frontend-auth-interceptor
<!-- MODEL_TIER {"tier":"standard","reason":"单文件但逻辑复杂（并发队列、localStorage 解析、循环依赖规避），需要仔细处理边界"} -->

#### 验收标准
- [ ] AC1.1: 在 apps/web/src/api/index.ts L6-10 的 axios.create() 后；添加 request interceptor，从 localStorage 读取 'auth-storage' key，解析 JSON 提取 state.token，注入 Authorization: Bearer <token> header；token 不存在时不注入 header；不修改 axios.create 的基础配置
- [ ] AC1.2: 在 apps/web/src/api/index.ts；添加 response interceptor，捕获 401 响应（排除 /auth/* 路径），从 localStorage 读取 state.refreshToken，调用 POST /auth/refresh（原始 axios 实例，非 api 避免循环），将响应中的 accessToken 更新为 localStorage state.token，将响应中的 refreshToken 更新为 localStorage state.refreshToken，用新 token 重试原始失败请求；refreshToken 不存在时直接 reject 不重试
- [ ] AC1.3: 在 apps/web/src/api/index.ts response interceptor 中；排除路径匹配 /auth/ 的请求（login、register、refresh、me、logout、guest-session）不触发自动刷新，避免无限循环；使用 URL 路径匹配（config.url）
- [ ] AC1.4: 在 apps/web/src/api/index.ts response interceptor 中；实现并发 401 请求队列——refresh 请求进行中时，后续 401 请求挂起到 Promise 队列，refresh 完成后用新 token 批量重试；refresh 失败时批量 reject 所有挂起请求

#### 涉及文件
- apps/web/src/api/index.ts

### oauth-token-fragment
<!-- MODEL_TIER {"tier":"fast","reason":"两文件各改几行，无新逻辑，无跨模块依赖"} -->

#### 验收标准
- [ ] AC2.1: 在 apps/api/src/modules/auth/oauth.routes.ts L81；将 redirect URL 从 query params（?token=...&refreshToken=...）改为 URL fragment（#token=...&refreshToken=...），使用 '#' + params.toString() 替代 '?' + params.toString()；保留 error 路由的 query param 格式不变（error 不敏感）
- [ ] AC2.2: 在 apps/web/src/components/OAuthCallback.tsx L24-25；将 token 和 refreshToken 的读取从 useSearchParams()（query params）改为解析 window.location.hash（URL fragment），使用 new URLSearchParams(window.location.hash.slice(1)) 解析；保留 error 的 query param 读取不变
- [ ] AC2.3: 在 apps/web/src/components/OAuthCallback.tsx；URL fragment 解析后立即清除 hash（window.history.replaceState(null, '', window.location.pathname)），防止 token 残留在浏览器地址栏和历史记录中

#### 涉及文件
- apps/api/src/modules/auth/oauth.routes.ts
- apps/web/src/components/OAuthCallback.tsx
## 约束
- axios interceptor 绝对不能 import authStore — circular dependency (authStore.ts:L9 imports from '../api')
- POST /auth/refresh 返回 {accessToken, refreshToken, userId} — 不是 {token, refreshToken}
- refresh 请求不能用 api 实例 — 会触发 interceptor 循环
- OAuth error redirect 保持 query param — fragment 在 redirect 中可能丢失
- guest session 24h 保持不变 — guest 不需要 7 天
- refresh token 30 天保持不变 — 独立于 JWT/session expiry

## AC Groups

```json
[
  {
    "id": "frontend-auth-interceptor",
    "acs": [
      "AC1.1: 在 apps/web/src/api/index.ts L6-10 的 axios.create() 后；添加 request interceptor，从 localStorage 读取 'auth-storage' key，解析 JSON 提取 state.token，注入 Authorization: Bearer <token> header；token 不存在时不注入 header；不修改 axios.create 的基础配置",
      "AC1.2: 在 apps/web/src/api/index.ts；添加 response interceptor，捕获 401 响应（排除 /auth/* 路径），从 localStorage 读取 state.refreshToken，调用 POST /auth/refresh（原始 axios 实例，非 api 避免循环），将响应中的 accessToken 更新为 localStorage state.token，将响应中的 refreshToken 更新为 localStorage state.refreshToken，用新 token 重试原始失败请求；refreshToken 不存在时直接 reject 不重试",
      "AC1.3: 在 apps/web/src/api/index.ts response interceptor 中；排除路径匹配 /auth/ 的请求（login、register、refresh、me、logout、guest-session）不触发自动刷新，避免无限循环；使用 URL 路径匹配（config.url）",
      "AC1.4: 在 apps/web/src/api/index.ts response interceptor 中；实现并发 401 请求队列——refresh 请求进行中时，后续 401 请求挂起到 Promise 队列，refresh 完成后用新 token 批量重试；refresh 失败时批量 reject 所有挂起请求"
    ],
    "files": [
      "apps/web/src/api/index.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. 在 axios.create() 后添加 api.interceptors.request.use(config => { ... }) 和 api.interceptors.response.use(onFulfilled, onRejected)。2. 关键约束：不能 import authStore（circular dep — authStore.ts:L9 imports from '../api'），必须直接读 localStorage。3. localStorage key 是 'auth-storage'，Zustand persist 格式：{ state: { token, refreshToken, user, session, guestId }, version: 0 }。4. POST /auth/refresh 返回 { accessToken, refreshToken, userId }（注意是 accessToken 不是 token）。5. refresh 请求必须用原始 axios 或独立 fetch，不能用 api 实例（会触发 interceptor 循环）。6. 队列实现：let isRefreshing = false; let failedQueue: Array<{resolve, reject}> = []; 401 时如果 isRefreshing 则 push 到队列，否则开始 refresh。refresh 完成后遍历 failedQueue resolve 所有 Promise。",
    "architectureContext": {
      "functions": [
        "axios.create(config) @ api/index.ts:L6 — 创建 axios 实例",
        "api.interceptors.request.use(onFulfilled, onRejected) — 请求拦截器 API",
        "api.interceptors.response.use(onFulfilled, onRejected) — 响应拦截器 API",
        "authApi.checkAuth() @ api/index.ts:L148 — GET /auth/me",
        "authApi.login() @ api/index.ts:L149 — POST /auth/login"
      ],
      "callChain": "53+ frontend consumers → api.get/post → request interceptor (inject Bearer) → backend requireAuth() → 401 → response interceptor → POST /auth/refresh → retry original request",
      "imports": [
        "import axios from 'axios' (already imported @ L2)",
        "NO authStore import — circular dependency (authStore.ts:L9 imports from '../api')"
      ],
      "typesInScope": [
        "AxiosRequestConfig — axios request config type",
        "AxiosError — axios error type with .response.status and .config",
        "InternalAxiosRequestConfig — axios internal config type for request interceptor"
      ],
      "testMock": [
        "vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() })",
        "vi.mock('axios', () => ({ default: { create: vi.fn(() => ({ interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } }, get: vi.fn(), post: vi.fn() })) } }))"
      ],
      "dangerZones": [
        "L6-10 axios.create() 的现有配置（baseURL, headers, withCredentials）不要修改",
        "L145-158 authApi 对象不要修改——它是独立的 API 定义，不参与 interceptor",
        "authStore.ts:L9 imports from '../api' — interceptor 绝对不能 import authStore，否则 circular dependency"
      ],
      "verifiedAt": "3469a18 (HEAD, no changes to auth files since)"
    },
    "codePatterns": [
      "参考 axios interceptor 官方文档: https://axios-http.com/docs/interceptors",
      "Zustand persist localStorage 格式: { state: {...}, version: 0 }"
    ],
    "gotchas": [
      "⚠️ circular dep: authStore.ts:L9 imports from '../api' — interceptor 不得 import authStore，读 localStorage 直接",
      "⚠️ POST /auth/refresh 返回 accessToken 不是 token — 更新 localStorage 时 key 是 token 但值取 accessToken",
      "⚠️ refresh 请求不能用 api 实例（会触发自身 interceptor）— 用原始 axios 或 fetch",
      "⚠️ withCredentials: true 已设置 — cookie 会自动发送，但 Bearer token 不会（需要 interceptor）"
    ],
    "modelTier": "standard",
    "modelTierReason": "单文件但逻辑复杂（并发队列、localStorage 解析、循环依赖规避），需要仔细处理边界"
  },
  {
    "id": "oauth-token-fragment",
    "acs": [
      "AC2.1: 在 apps/api/src/modules/auth/oauth.routes.ts L81；将 redirect URL 从 query params（?token=...&refreshToken=...）改为 URL fragment（#token=...&refreshToken=...），使用 '#' + params.toString() 替代 '?' + params.toString()；保留 error 路由的 query param 格式不变（error 不敏感）",
      "AC2.2: 在 apps/web/src/components/OAuthCallback.tsx L24-25；将 token 和 refreshToken 的读取从 useSearchParams()（query params）改为解析 window.location.hash（URL fragment），使用 new URLSearchParams(window.location.hash.slice(1)) 解析；保留 error 的 query param 读取不变",
      "AC2.3: 在 apps/web/src/components/OAuthCallback.tsx；URL fragment 解析后立即清除 hash（window.history.replaceState(null, '', window.location.pathname)），防止 token 残留在浏览器地址栏和历史记录中"
    ],
    "files": [
      "apps/api/src/modules/auth/oauth.routes.ts",
      "apps/web/src/components/OAuthCallback.tsx"
    ],
    "dependencies": [],
    "implementationNotes": "1. 后端改动极小：oauth.routes.ts L81 把 '?' 改成 '#'。2. 前端改动：OAuthCallback.tsx 不再用 useSearchParams 读 token/refreshToken，改用 window.location.hash。3. error 参数保持 query param 不变（error 不敏感，且浏览器可能不保留 fragment on redirect）。4. 清除 hash 是安全措施——防止 token 残留在 URL 栏。5. 不需要改 authStore 或 api/index.ts。",
    "architectureContext": {
      "functions": [
        "oauth.routes.ts L18 router.get('/:provider(google|github)') — OAuth 入口",
        "oauth.routes.ts L43 router.get('/callback/:provider(google|github)') — OAuth 回调处理",
        "oauth.routes.ts L81 res.redirect() — 当前用 query params，需改为 fragment",
        "OAuthCallback.tsx L10 function OAuthCallback() — OAuth 回调组件",
        "OAuthCallback.tsx L11 useSearchParams() — 当前读 query params",
        "OAuthCallback.tsx L13-14 useAuthStore(s => s.setToken / s.checkAuth)"
      ],
      "callChain": "OAuth provider → redirect → /auth/callback/:provider?code=...&state=... → oauth.routes.ts verifies state + exchanges code → redirect to frontend /auth/callback#token=... → OAuthCallback parses hash → setToken → checkAuth → navigate /channels",
      "imports": [
        "oauth.routes.ts: import crypto from 'crypto' (L2), import * as oauthService from './oauth.service.js' (L3)",
        "OAuthCallback.tsx: import { useEffect } from 'react' (L1), import { useNavigate, useSearchParams } from 'react-router-dom' (L2), import { useAuthStore } from '../stores/authStore' (L3)"
      ],
      "typesInScope": [
        "OAuthProvider = 'google' | 'github' @ oauth.routes.ts:L12",
        "URLSearchParams — 原生 API，用于解析 query string"
      ],
      "testMock": [
        "vi.mock('react-router-dom', () => ({ useNavigate: vi.fn(() => vi.fn()), useSearchParams: vi.fn(() => [new URLSearchParams()]) }))",
        "vi.mock('../stores/authStore', () => ({ useAuthStore: vi.fn(() => vi.fn()) }))"
      ],
      "dangerZones": [
        "oauth.routes.ts L47-60 CSRF state 验证逻辑不要动",
        "oauth.routes.ts L52-54 error redirect 保持 query param 格式",
        "OAuthCallback.tsx L16-37 useEffect 依赖数组不要改",
        "App.tsx L139-147 /auth/callback 路由 bypass 不要改"
      ],
      "verifiedAt": "3469a18 (HEAD, no changes to auth files since)"
    },
    "codePatterns": [
      "URL fragment 解析: new URLSearchParams(window.location.hash.slice(1))",
      "清除 hash: window.history.replaceState(null, '', window.location.pathname)"
    ],
    "gotchas": [
      "⚠️ error 参数保持 query param — fragment 在某些 redirect 场景可能丢失",
      "⚠️ URLSearchParams 可以解析 fragment 内容（它只关心 key=value 格式，不关心前缀）",
      "⚠️ 浏览器地址栏会短暂显示 fragment — replaceState 清除是安全措施",
      "⚠️ oauth.routes.ts L75 注释已说 'URL fragment' 但 L81 代码用 '?' — 这是 bug，AC2.1 修复它"
    ],
    "modelTier": "fast",
    "modelTierReason": "两文件各改几行，无新逻辑，无跨模块依赖"
  }
]
```

## Files

- apps/api/src/modules/auth/oauth.routes.ts
- apps/web/src/api/index.ts
- apps/web/src/components/OAuthCallback.tsx