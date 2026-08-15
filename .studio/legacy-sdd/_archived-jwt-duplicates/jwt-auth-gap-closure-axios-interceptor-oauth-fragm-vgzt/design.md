---
id: "cmq6he2at01vsqnnh6s0gml7q"
goalId: "cmq6he5xp01w3qnnh3ckzvgzt"
slug: "jwt-auth-gap-closure-axios-interceptor-oauth-fragm-vgzt"
title: "JWT Auth Gap Closure — Axios Interceptor + OAuth Fragment Security + Expiry Consistency"
status: "stale"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "jwt", "oauth", "interceptor", "security", "frontend", "backend"]
createdAt: "2026-06-09T10:12:37.532Z"
updatedAt: "2026-06-09T10:12:42.317Z"
---

> **DEPRECATED**: Superseded by `jwt-auth-gap-closure-axios-interceptor-oauth-fragm`. This doc is kept for historical reference only.

# JWT Auth Gap Closure — Axios Interceptor + OAuth Fragment Security + Expiry Consistency

Backend JWT/OAuth/refresh-token system is complete (32 tests pass). Remaining gaps: (1) frontend axios interceptor for automatic Bearer injection + 401 refresh queue, (2) OAuth token URL fragment security fix to prevent Referer leakage, (3) JWT/session expiry alignment between OAuth and email/password flows.

<!-- TASK_TIER {"tier":"standard","reason":"3 AC groups across 4 files (2 frontend, 2 backend), cross-module dependency (interceptor reads localStorage shape defined by authStore). No schema changes, no new modules, no architecture decisions."} -->

## Architecture Context

### frontend-auth-interceptor

**Functions**
- axios.create(config) @ api/index.ts:L6 — 创建 axios 实例
- api.interceptors.request.use(onFulfilled, onRejected) — 请求拦截器 API
- api.interceptors.response.use(onFulfilled, onRejected) — 响应拦截器 API
- authApi.checkAuth() @ api/index.ts:L148 — GET /auth/me
- authApi.login() @ api/index.ts:L149 — POST /auth/login

**Call Chain**
53+ frontend consumers → api.get/post → request interceptor (inject Bearer) → backend requireAuth() → 401 → response interceptor → POST /auth/refresh → retry original request

**Imports**
- import axios from 'axios' (already imported @ L2)
- NO authStore import — circular dependency (authStore.ts:L9 imports from '../api')

**Types in Scope**
- AxiosRequestConfig — axios request config type
- AxiosError — axios error type with .response.status and .config
- InternalAxiosRequestConfig — axios internal config type for request interceptor

**Test Mocks**
- vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() })
- vi.mock('axios', () => ({ default: { create: vi.fn(() => ({ interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } }, get: vi.fn(), post: vi.fn() })) } }))

**Danger Zones**
- L6-10 axios.create() 的现有配置（baseURL, headers, withCredentials）不要修改
- L145-158 authApi 对象不要修改——它是独立的 API 定义，不参与 interceptor
- authStore.ts:L9 imports from '../api' — interceptor 绝对不能 import authStore，否则 circular dependency

### oauth-token-fragment

**Functions**
- oauth.routes.ts L18 router.get('/:provider(google|github)') — OAuth 入口
- oauth.routes.ts L43 router.get('/callback/:provider(google|github)') — OAuth 回调处理
- oauth.routes.ts L81 res.redirect() — 当前用 query params，需改为 fragment
- OAuthCallback.tsx L10 function OAuthCallback() — OAuth 回调组件
- OAuthCallback.tsx L11 useSearchParams() — 当前读 query params
- OAuthCallback.tsx L13-14 useAuthStore(s => s.setToken / s.checkAuth)

**Call Chain**
OAuth provider → redirect → /auth/callback/:provider?code=...&state=... → oauth.routes.ts verifies state + exchanges code → redirect to frontend /auth/callback#token=... → OAuthCallback parses hash → setToken → checkAuth → navigate /channels

**Imports**
- oauth.routes.ts: import crypto from 'crypto' (L2), import * as oauthService from './oauth.service.js' (L3)
- OAuthCallback.tsx: import { useEffect } from 'react' (L1), import { useNavigate, useSearchParams } from 'react-router-dom' (L2), import { useAuthStore } from '../stores/authStore' (L3)

**Types in Scope**
- OAuthProvider = 'google' | 'github' @ oauth.routes.ts:L12
- URLSearchParams — 原生 API，用于解析 query string

**Test Mocks**
- vi.mock('react-router-dom', () => ({ useNavigate: vi.fn(() => vi.fn()), useSearchParams: vi.fn(() => [new URLSearchParams()]) }))
- vi.mock('../stores/authStore', () => ({ useAuthStore: vi.fn(() => vi.fn()) }))

**Danger Zones**
- oauth.routes.ts L47-60 CSRF state 验证逻辑不要动
- oauth.routes.ts L52-54 error redirect 保持 query param 格式
- OAuthCallback.tsx L16-37 useEffect 依赖数组不要改
- App.tsx L139-147 /auth/callback 路由 bypass 不要改

### jwt-expiry-consistency

**Functions**
- createOAuthSession(userId: string, req: {ip?: string; headers: Record<string, string | undefined>}) @ oauth.service.ts:L316 — 创建 OAuth session + JWT + refresh token
- generateToken(sessionId: string, userId?: string) @ service.ts:L75 — JWT sign {sid, uid}, 7 day expiry (private)
- generateRefreshToken(userId: string) @ service.ts:L306 — 30-day refresh token

**Call Chain**
oauth.routes.ts callback → oauthService.createOAuthSession(userId, reqInfo) → prisma.session.create + jwt.sign + generateRefreshToken

**Imports**
- import jwt from 'jsonwebtoken' (already imported in oauth.service.ts)
- import { JWT_SECRET, generateRefreshToken } from './service.js' (already imported)

**Types in Scope**
- AuthResult @ service.ts:L36 — { user?, session, token, isNewUser?, refreshToken? }

**Test Mocks**
- vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn() }))
- vi.mock('./service.js', () => ({ JWT_SECRET: 'test-secret', generateRefreshToken: vi.fn().mockResolvedValue('mock-refresh-token') }))

**Danger Zones**
- oauth.service.ts L334 jwt.sign payload {sid, uid} 不要改（已与 service.ts 对齐）
- oauth.service.ts L346 generateRefreshToken(userId) 调用不要改（30天 refresh token 保持不变）
- service.ts L17 GUEST_EXPIRES_HOURS = 24 — guest session 不改，guest 不需要 7 天

## AC Groups

### frontend-auth-interceptor

#### 实现指南
1. 在 axios.create() 后添加 api.interceptors.request.use(config => { ... }) 和 api.interceptors.response.use(onFulfilled, onRejected)。2. 关键约束：不能 import authStore（circular dep — authStore.ts:L9 imports from '../api'），必须直接读 localStorage。3. localStorage key 是 'auth-storage'，Zustand persist 格式：{ state: { token, refreshToken, user, session, guestId }, version: 0 }。4. POST /auth/refresh 返回 { accessToken, refreshToken, userId }（注意是 accessToken 不是 token）。5. refresh 请求必须用原始 axios 或独立 fetch，不能用 api 实例（会触发 interceptor 循环）。6. 队列实现：let isRefreshing = false; let failedQueue: Array<{resolve, reject}> = []; 401 时如果 isRefreshing 则 push 到队列，否则开始 refresh。refresh 完成后遍历 failedQueue resolve 所有 Promise。

#### 参考模式
- 参考 axios interceptor 官方文档: https://axios-http.com/docs/interceptors
- Zustand persist localStorage 格式: { state: {...}, version: 0 }

#### ⚠️ 注意事项
- ⚠️ circular dep: authStore.ts:L9 imports from '../api' — interceptor 不得 import authStore，读 localStorage 直接
- ⚠️ POST /auth/refresh 返回 accessToken 不是 token — 更新 localStorage 时 key 是 token 但值取 accessToken
- ⚠️ refresh 请求不能用 api 实例（会触发自身 interceptor）— 用原始 axios 或 fetch
- ⚠️ withCredentials: true 已设置 — cookie 会自动发送，但 Bearer token 不会（需要 interceptor）
- ⚠️ 11 files use raw fetch via utils/api.ts — 不经过 axios interceptor，不在本次范围内

### oauth-token-fragment

#### 实现指南
1. 后端改动极小：oauth.routes.ts L81 把 '?' 改成 '#'。2. 前端改动：OAuthCallback.tsx 不再用 useSearchParams 读 token/refreshToken，改用 window.location.hash。3. error 参数保持 query param 不变（error 不敏感，且浏览器可能不保留 fragment on redirect）。4. 清除 hash 是安全措施——防止 token 残留在 URL 栏。5. 不需要改 authStore 或 api/index.ts。

#### 参考模式
- URL fragment 解析: new URLSearchParams(window.location.hash.slice(1))
- 清除 hash: window.history.replaceState(null, '', window.location.pathname)

#### ⚠️ 注意事项
- ⚠️ error 参数保持 query param — fragment 在某些 redirect 场景可能丢失
- ⚠️ URLSearchParams 可以解析 fragment 内容（它只关心 key=value 格式，不关心前缀）
- ⚠️ 浏览器地址栏会短暂显示 fragment — replaceState 清除是安全措施

### jwt-expiry-consistency

#### 实现指南
1. 两处改动都在 oauth.service.ts 的 createOAuthSession 函数内。2. L320: new Date(Date.now() + 24 * 60 * 60 * 1000) → new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)。3. L336: { expiresIn: '24h' } → { expiresIn: '7d' }。4. 不需要改 service.ts（已经是 7 天）。5. 不需要改 Prisma schema（expiresAt 是 DateTime，精度足够）。6. refresh token 仍然是 30 天（service.ts L301 REFRESH_TOKEN_EXPIRY_DAYS）。

#### 参考模式
- service.ts L182-183: expiresAt.setDate(expiresAt.getDate() + 7) — email/password session 7天
- service.ts L14: JWT_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60 — JWT 7天

#### ⚠️ 注意事项
- ⚠️ refresh token 仍然是 30 天（service.ts L301 REFRESH_TOKEN_EXPIRY_DAYS）— 不改
- ⚠️ guest session 仍然是 24h（service.ts L17 GUEST_EXPIRES_HOURS）— 不改，guest 不需要 7 天