---
id: "sdd-1784366584319-fb6jfa"
goalId: "cmq7g1mwq00bk13h6sg979x6r"
slug: "auth-endpoints-rate-limiting"
title: "Auth Endpoints Rate Limiting"
status: "done"
version: 7
designVersion: 7
parentId: "sdd-1784366260735-22shx2"
changeType: "L3"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["security", "auth", "rate-limiting", "brute-force-prevention"]
createdAt: "2026-06-10T02:22:37.888Z"
updatedAt: "2026-07-18T09:23:04.319Z"
---

# Auth Endpoints Rate Limiting

为 login/register/refresh 端点添加基于 IP 的速率限制，防止暴力破解攻击

<!-- TASK_TIER {"tier":"standard","reason":"修改 2 文件（rate-limit.ts 扩展 + routes.ts 接入），无 schema 变更，但 refresh 端点公开无认证属高风险安全修复"} -->

## Architecture Context

**Functions**
- rateLimit(options?) — express-rate-limit 默认导出，返回 Express RequestHandler @ rate-limit.ts:L8
- router.post(path, ...handlers) — Express Router 方法 @ routes.ts:L15,L33,L73,L121,L164,L177

**Call Chain**
HTTP request → express middleware chain → authRateLimit/refreshRateLimit (IP check) → route handler → authService.login/register/exchangeRefreshToken

**Imports**
- import rateLimit from 'express-rate-limit';  // 已存在于 rate-limit.ts L8
- import { authRateLimit, refreshRateLimit } from '../../middleware/rate-limit.js';  // 新增到 routes.ts L2

**Types in Scope**
- RateLimitRequestHandler — express-rate-limit 返回类型 (express middleware)
- RateLimitMessageOption — message 配置类型

**Test Mocks**
- vi.mock('express-rate-limit', () => ({ default: vi.fn(() => (req, res, next) => next()) }))
- 或者直接测真实中间件：使用 supertest 发送 >max 请求验证 429 返回

**Danger Zones**
- rate-limit.ts L14-24 mcpRateLimit 和 L30-38 apiRateLimit — 不要碰，它们是独立的导出
- routes.ts L15 /guest-session — 不加限流（guest session 是正常流程，不属于敏感端点）
- routes.ts L121 /logout — 不加限流（需要认证，且注销操作无攻击价值）
- routes.ts L146 /me — 不加限流（GET 请求，只读，已有 optionalAuth）

## AC Groups

### auth-rate-limit

#### 实现指南
Step 1: 在 rate-limit.ts L38 后追加两个新导出。Step 2: 在 routes.ts L2 添加 import { authRateLimit, refreshRateLimit } from '../../middleware/rate-limit.js'。Step 3: 修改 L33/L73/L177 的 router.post 调用，在 async handler 前插入对应中间件。选择 10/min 给 login+register（bcrypt 慢哈希本身就慢，10 次已足够探测）、20/min 给 refresh（合法用户刷新频率高于登录）。

#### 参考模式
- rate-limit.ts:L14-24 mcpRateLimit — 现有模式，直接复制修改 max 和 message
- routes.ts:L121 router.post('/logout', requireAuth(), ...) — 中间件链模式参考

#### ⚠️ 注意事项
- ⚠️ express-rate-limit v8 默认 store 是内存 Store — 单实例够用，多实例部署需 Redis store（当前项目是单实例，无需担心）
- ⚠️ 默认 keyGenerator 使用 req.ip — 需确认 app.ts 中 trust proxy 设置正确，否则反向代理后所有请求同一 IP
- ⚠️ 不要给 /guest-session 加限流 — guest session 创建是正常 UX，不是攻击面