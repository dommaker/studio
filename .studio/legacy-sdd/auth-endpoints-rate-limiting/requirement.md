---
id: "cmq7g1hz600az13h69i9k7edh"
workUnitId: "cmq7g1mwq00bk13h6sg979x6r"
slug: "auth-endpoints-rate-limiting"
title: "Auth Endpoints Rate Limiting"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["security", "auth", "rate-limiting", "brute-force-prevention"]
createdAt: "2026-06-10T02:22:37.888Z"
updatedAt: "2026-06-10T02:22:44.489Z"
---

# Auth Endpoints Rate Limiting

为 login/register/refresh 端点添加基于 IP 的速率限制，防止暴力破解攻击

<!-- TASK_TIER {"tier":"standard","reason":"修改 2 文件（rate-limit.ts 扩展 + routes.ts 接入），无 schema 变更，但 refresh 端点公开无认证属高风险安全修复"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["express-rate-limit v8.3.2 — apps/api/src/package.json L40","rateLimit() 函数 — apps/api/src/middleware/rate-limit.ts L8 (import from express-rate-limit)","POST /auth/login — routes.ts L73 (router.post, 无中间件)","POST /auth/register — routes.ts L33 (router.post, 无中间件)","POST /auth/refresh — routes.ts L177 (router.post, 无中间件)","express-rate-limit standardHeaders + legacyHeaders API — rate-limit.ts L17-18 已使用"],"unverified":[],"newRequired":["authRateLimit — 新增导出 (rate-limit.ts)，10 req/min/IP，用于 login+register","refreshRateLimit — 新增导出 (rate-limit.ts)，20 req/min/IP，用于 refresh"]} -->

### Verified
- ✅ express-rate-limit v8.3.2 — apps/api/src/package.json L40
- ✅ rateLimit() 函数 — apps/api/src/middleware/rate-limit.ts L8 (import from express-rate-limit)
- ✅ POST /auth/login — routes.ts L73 (router.post, 无中间件)
- ✅ POST /auth/register — routes.ts L33 (router.post, 无中间件)
- ✅ POST /auth/refresh — routes.ts L177 (router.post, 无中间件)
- ✅ express-rate-limit standardHeaders + legacyHeaders API — rate-limit.ts L17-18 已使用

### 🆕 New Required
- 📝 authRateLimit — 新增导出 (rate-limit.ts)，10 req/min/IP，用于 login+register
- 📝 refreshRateLimit — 新增导出 (rate-limit.ts)，20 req/min/IP，用于 refresh

## AC Groups

### auth-rate-limit
<!-- MODEL_TIER {"tier":"fast","reason":"2 文件修改，无新建文件，无 schema 变更，复用已有 express-rate-limit 模式，但安全修复需确保不遗漏端点"} -->

#### 验收标准
- [ ] AC1: 在 rate-limit.ts 中添加 authRateLimit 导出；使用 express-rate-limit，windowMs=60000，max=10，keyGenerator 使用默认 IP，standardHeaders=true，legacyHeaders=false，message={ error: 'Too many login attempts, please try again later' }；不修改已有的 mcpRateLimit 和 apiRateLimit
- [ ] AC2: 在 rate-limit.ts 中添加 refreshRateLimit 导出；使用 express-rate-limit，windowMs=60000，max=20，keyGenerator 使用默认 IP，standardHeaders=true，legacyHeaders=false，message={ error: 'Too many refresh attempts, please try again later' }；不修改已有的 mcpRateLimit 和 apiRateLimit
- [ ] AC3: 在 routes.ts L33 的 /register 路由上添加 authRateLimit 中间件；router.post('/register', authRateLimit, async (req, res) => {...})；不改动 /register 处理逻辑和其他中间件
- [ ] AC4: 在 routes.ts L73 的 /login 路由上添加 authRateLimit 中间件；router.post('/login', authRateLimit, async (req, res) => {...})；不改动 /login 处理逻辑和其他中间件
- [ ] AC5: 在 routes.ts L177 的 /refresh 路由上添加 refreshRateLimit 中间件；router.post('/refresh', refreshRateLimit, async (req, res) => {...})；不改动 /refresh 处理逻辑和其他中间件

#### 涉及文件
- apps/api/src/middleware/rate-limit.ts
- apps/api/src/modules/auth/routes.ts
## 约束
- 使用已安装的 express-rate-limit v8.3.2，不引入新依赖
- 不修改已有的 mcpRateLimit 和 apiRateLimit 定义（死代码，单独处理）
- 限流配置硬编码（与现有 mcpRateLimit/apiRateLimit 保持一致），不引入环境变量
- 不改动 OAuth 路由（oauth.routes.ts）— OAuth callback 由 provider 重定向触发，非用户直接调用
- 不给 /guest-session、/logout、/me、/cleanup 加限流（非敏感端点或已认证）

## AC Groups

```json
[
  {
    "id": "auth-rate-limit",
    "acs": [
      "AC1: 在 rate-limit.ts 中添加 authRateLimit 导出；使用 express-rate-limit，windowMs=60000，max=10，keyGenerator 使用默认 IP，standardHeaders=true，legacyHeaders=false，message={ error: 'Too many login attempts, please try again later' }；不修改已有的 mcpRateLimit 和 apiRateLimit",
      "AC2: 在 rate-limit.ts 中添加 refreshRateLimit 导出；使用 express-rate-limit，windowMs=60000，max=20，keyGenerator 使用默认 IP，standardHeaders=true，legacyHeaders=false，message={ error: 'Too many refresh attempts, please try again later' }；不修改已有的 mcpRateLimit 和 apiRateLimit",
      "AC3: 在 routes.ts L33 的 /register 路由上添加 authRateLimit 中间件；router.post('/register', authRateLimit, async (req, res) => {...})；不改动 /register 处理逻辑和其他中间件",
      "AC4: 在 routes.ts L73 的 /login 路由上添加 authRateLimit 中间件；router.post('/login', authRateLimit, async (req, res) => {...})；不改动 /login 处理逻辑和其他中间件",
      "AC5: 在 routes.ts L177 的 /refresh 路由上添加 refreshRateLimit 中间件；router.post('/refresh', refreshRateLimit, async (req, res) => {...})；不改动 /refresh 处理逻辑和其他中间件"
    ],
    "files": [
      "apps/api/src/middleware/rate-limit.ts",
      "apps/api/src/modules/auth/routes.ts"
    ],
    "dependencies": [],
    "implementationNotes": "Step 1: 在 rate-limit.ts L38 后追加两个新导出。Step 2: 在 routes.ts L2 添加 import { authRateLimit, refreshRateLimit } from '../../middleware/rate-limit.js'。Step 3: 修改 L33/L73/L177 的 router.post 调用，在 async handler 前插入对应中间件。选择 10/min 给 login+register（bcrypt 慢哈希本身就慢，10 次已足够探测）、20/min 给 refresh（合法用户刷新频率高于登录）。",
    "architectureContext": {
      "functions": [
        "rateLimit(options?) — express-rate-limit 默认导出，返回 Express RequestHandler @ rate-limit.ts:L8",
        "router.post(path, ...handlers) — Express Router 方法 @ routes.ts:L15,L33,L73,L121,L164,L177"
      ],
      "callChain": "HTTP request → express middleware chain → authRateLimit/refreshRateLimit (IP check) → route handler → authService.login/register/exchangeRefreshToken",
      "imports": [
        "import rateLimit from 'express-rate-limit';  // 已存在于 rate-limit.ts L8",
        "import { authRateLimit, refreshRateLimit } from '../../middleware/rate-limit.js';  // 新增到 routes.ts L2"
      ],
      "typesInScope": [
        "RateLimitRequestHandler — express-rate-limit 返回类型 (express middleware)",
        "RateLimitMessageOption — message 配置类型"
      ],
      "testMock": [
        "vi.mock('express-rate-limit', () => ({ default: vi.fn(() => (req, res, next) => next()) }))",
        "或者直接测真实中间件：使用 supertest 发送 >max 请求验证 429 返回"
      ],
      "dangerZones": [
        "rate-limit.ts L14-24 mcpRateLimit 和 L30-38 apiRateLimit — 不要碰，它们是独立的导出",
        "routes.ts L15 /guest-session — 不加限流（guest session 是正常流程，不属于敏感端点）",
        "routes.ts L121 /logout — 不加限流（需要认证，且注销操作无攻击价值）",
        "routes.ts L146 /me — 不加限流（GET 请求，只读，已有 optionalAuth）"
      ],
      "verifiedAt": "85c2855"
    },
    "codePatterns": [
      "rate-limit.ts:L14-24 mcpRateLimit — 现有模式，直接复制修改 max 和 message",
      "routes.ts:L121 router.post('/logout', requireAuth(), ...) — 中间件链模式参考"
    ],
    "gotchas": [
      "⚠️ express-rate-limit v8 默认 store 是内存 Store — 单实例够用，多实例部署需 Redis store（当前项目是单实例，无需担心）",
      "⚠️ 默认 keyGenerator 使用 req.ip — 需确认 app.ts 中 trust proxy 设置正确，否则反向代理后所有请求同一 IP",
      "⚠️ 不要给 /guest-session 加限流 — guest session 创建是正常 UX，不是攻击面"
    ],
    "modelTier": "fast",
    "modelTierReason": "2 文件修改，无新建文件，无 schema 变更，复用已有 express-rate-limit 模式，但安全修复需确保不遗漏端点"
  }
]
```

## Files

- apps/api/src/middleware/rate-limit.ts
- apps/api/src/modules/auth/routes.ts