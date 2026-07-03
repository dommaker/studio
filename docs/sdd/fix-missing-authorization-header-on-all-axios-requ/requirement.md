---
id: "cmq6fyqug01kvqnnh8b96swto"
workUnitId: "cmq6fyxeh01l6qnnhloho3e5b"
slug: "fix-missing-authorization-header-on-all-axios-requ"
title: "Fix Missing Authorization Header on All Axios Requests"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "axios", "interceptor", "frontend", "critical-bug", "SEC-001"]
createdAt: "2026-06-09T09:32:43.213Z"
updatedAt: "2026-06-09T09:32:51.785Z"
---

# Fix Missing Authorization Header on All Axios Requests

Add axios request/response interceptors to inject Bearer token from localStorage. Auth path and response shape fixes already staged/unstaged in working tree — only the interceptor wiring remains.

<!-- TASK_TIER {"tier":"standard","reason":"Single file change (api/index.ts) but with circular dependency constraint, localStorage JSON parsing, token refresh flow, and 53 consumers affected. Previous comprehensive analysis at output-1780992820455-zhl8.json."} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["POST /api/v1/auth/refresh — routes.ts:L177 (public, no auth required, accepts { refreshToken })","requireAuth() — middleware/auth.ts:L146 — parses Bearer via parseAuthHeader() @ L79-89","Zustand persist key 'auth-storage' — authStore.ts:L204","partialize includes: token, refreshToken, user, session, guestId — authStore.ts:L205-L211 (unstaged)","exchangeRefreshToken(refreshToken) — auth/service.ts:L321 — rotation: revokes old, returns { accessToken, refreshToken, userId }"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ POST /api/v1/auth/refresh — routes.ts:L177 (public, no auth required, accepts { refreshToken })
- ✅ requireAuth() — middleware/auth.ts:L146 — parses Bearer via parseAuthHeader() @ L79-89
- ✅ Zustand persist key 'auth-storage' — authStore.ts:L204
- ✅ partialize includes: token, refreshToken, user, session, guestId — authStore.ts:L205-L211 (unstaged)
- ✅ exchangeRefreshToken(refreshToken) — auth/service.ts:L321 — rotation: revokes old, returns { accessToken, refreshToken, userId }

## AC Groups

### axios-interceptor
<!-- MODEL_TIER {"tier":"standard","reason":"循环依赖约束 + localStorage 格式解析 + refresh 流程 + _retry 防递归，需要精确实现"} -->

#### 验收标准
- [ ] AC1.1: 在 apps/web/src/api/index.ts L10 后（axios.create 之后）；添加 request interceptor，从 localStorage key 'auth-storage' 读取 JSON，提取 state.token，若存在则注入 headers.Authorization = `Bearer ${token}`；不 import authStore（循环依赖——authStore.ts:L9 imports from '../api'）；不修改 axios.create 配置
- [ ] AC1.2: 在 apps/web/src/api/index.ts；添加 response interceptor，onError 中判断 error.response.status === 401 且请求路径不含 '/auth/'（排除登录/注册/刷新的 401），则从 localStorage 读 refreshToken，若存在则 POST /auth/refresh，成功后更新 localStorage 中的 token 并重试原请求；refresh 失败则清除 localStorage 'auth-storage' 并 window.location.href = '/'；无 refreshToken 则直接清除+跳转

#### 涉及文件
- apps/web/src/api/index.ts
## 约束
- 不可 import authStore 到 api/index.ts — 循环依赖（authStore.ts:L9 imports from '../api'）
- 不可删除 withCredentials: true — CORS cookie 需要
- 不可修改 DeleteButton.tsx — 唯一正确发送 auth 的组件（raw fetch + getAuthHeader），不受 interceptor 影响
- 不可修改后端 auth routes — 前端适配后端，非反向
- 11 个 raw fetch 文件不在本 spec 范围 — 使用原生 fetch 不经过 axios instance
- refresh 请求必须用原始 axios 而非 api instance — 防止 interceptor 递归

## AC Groups

```json
[
  {
    "id": "axios-interceptor",
    "acs": [
      "AC1.1: 在 apps/web/src/api/index.ts L10 后（axios.create 之后）；添加 request interceptor，从 localStorage key 'auth-storage' 读取 JSON，提取 state.token，若存在则注入 headers.Authorization = `Bearer ${token}`；不 import authStore（循环依赖——authStore.ts:L9 imports from '../api'）；不修改 axios.create 配置",
      "AC1.2: 在 apps/web/src/api/index.ts；添加 response interceptor，onError 中判断 error.response.status === 401 且请求路径不含 '/auth/'（排除登录/注册/刷新的 401），则从 localStorage 读 refreshToken，若存在则 POST /auth/refresh，成功后更新 localStorage 中的 token 并重试原请求；refresh 失败则清除 localStorage 'auth-storage' 并 window.location.href = '/'；无 refreshToken 则直接清除+跳转"
    ],
    "files": [
      "apps/web/src/api/index.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. 在 api/index.ts 的 axios.create() 之后 (L10 后) 添加 request interceptor:\n   api.interceptors.request.use(config => { try { const raw = localStorage.getItem('auth-storage'); if (raw) { const parsed = JSON.parse(raw); const token = parsed?.state?.token; if (token) config.headers.Authorization = `Bearer ${token}`; } } catch {} return config; })\n2. 添加 response interceptor:\n   api.interceptors.response.use(r => r, async error => { const config = error.config; if (error.response?.status === 401 && !config.url?.includes('/auth/') && !config._retry) { config._retry = true; try { const raw = localStorage.getItem('auth-storage'); if (!raw) throw new Error('no auth'); const parsed = JSON.parse(raw); const rt = parsed?.state?.refreshToken; if (!rt) throw new Error('no refresh'); const { data } = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken: rt }); // update localStorage parsed.state.token = data.accessToken; if (data.refreshToken) parsed.state.refreshToken = data.refreshToken; localStorage.setItem('auth-storage', JSON.stringify(parsed)); config.headers.Authorization = `Bearer ${data.accessToken}`; return api(config); } catch { localStorage.removeItem('auth-storage'); window.location.href = '/'; } } return Promise.reject(error); })\n3. ⚠️ refresh 请求用 axios.post 而非 api.post，避免 interceptor 递归\n4. ⚠️ localStorage JSON 解析必须 try-catch\n5. auth-api-paths 和 auth-response-shape 已在 working tree 中修复（staged + unstaged）",
    "architectureContext": {
      "functions": [
        "axios.create(config) @ api/index.ts:L6 — 返回 AxiosInstance",
        "api.interceptors.request.use(onFulfilled, onRejected) — Axios interceptor API",
        "api.interceptors.response.use(onFulfilled, onRejected) — Axios interceptor API",
        "exchangeRefreshToken(refreshToken: string) @ auth/service.ts:L321 — rotation: revoke old + create new session + new access/refresh tokens",
        "POST /auth/refresh @ routes.ts:L177 — public route, body: { refreshToken }, returns: { accessToken, refreshToken, userId }"
      ],
      "callChain": "任何组件 → api.get/post() → request interceptor (inject Bearer) → HTTP → backend requireAuth() → parseAuthHeader() → verifyToken() → 401 or next() → response interceptor (401 → refresh → retry or clear)",
      "imports": [
        "import axios from 'axios' — already imported @ api/index.ts:L2",
        "不需要 import authStore — 循环依赖，直接读 localStorage"
      ],
      "typesInScope": [
        "AxiosRequestConfig — axios 内置类型",
        "AxiosResponse — axios 内置类型",
        "AxiosError — axios 内置类型",
        "Zustand persist 格式: { state: { token, refreshToken, user, session, guestId }, version: 0 }"
      ],
      "testMock": [
        "vi.mock('axios', () => ({ default: { create: vi.fn(() => ({ interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } }, get: vi.fn(), post: vi.fn() })), post: vi.fn() } }))",
        "const localStorageMock = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() }; Object.defineProperty(window, 'localStorage', { value: localStorageMock })"
      ],
      "dangerZones": [
        "authStore.ts:L9 — imports from '../api' — interceptor 在 api/index.ts 中不可 import authStore，否则循环依赖",
        "api/index.ts:L6-L10 — axios.create 配置不要改，withCredentials: true 必须保留（CORS cookie）",
        "auth 路径排除: response interceptor 必须排除含 '/auth/' 的请求路径，否则登录失败 401 会触发 refresh 循环",
        "refresh 请求必须用原始 axios.post 而非 api.post，否则会触发自己的 interceptor 递归",
        "localStorage JSON 解析必须 try-catch，防止脏数据导致 crash"
      ],
      "verifiedAt": "1c4bb9a (HEAD)"
    },
    "codePatterns": [
      "参考: DeleteButton.tsx:L75-L81 — getAuthHeader() + raw fetch 模式（正确发送 auth 的唯一组件）",
      "参考: authStore.ts:L192-L196 — getAuthHeader() 实现: { Authorization: `Bearer ${token}` }"
    ],
    "gotchas": [
      "⚠️ 循环依赖: authStore.ts:L9 imports from '../api' — interceptor 不能 import authStore，必须直接读 localStorage.getItem('auth-storage')",
      "⚠️ Zustand persist 格式: localStorage 值是 JSON.stringify({ state: { token, refreshToken, ... }, version: 0 })，不是直接的 token 字符串",
      "⚠️ withCredentials: true 必须保留（L9）— CORS 请求需要 cookie",
      "⚠️ refresh 请求本身会触发 401（如果 refreshToken 也过期）— 必须用 _retry flag 或排除 /auth/ 路径防循环",
      "⚠️ 53 文件消费 api instance — interceptor 生效后所有请求自动带 token，无需逐文件修改",
      "⚠️ 11 个 raw fetch 文件（RolesPage, ToolList 等）不经过 axios instance，interceptor 不覆盖 — 独立任务"
    ],
    "modelTier": "standard",
    "modelTierReason": "循环依赖约束 + localStorage 格式解析 + refresh 流程 + _retry 防递归，需要精确实现"
  }
]
```

## Files

- apps/web/src/api/index.ts