---
id: "cmq6rrjcx00cjpuv97jacmkns"
workUnitId: "cmq6rrnwz00czpuv9iknxuwk2"
slug: "jwt-auth-system"
title: "JWT 认证系统安全加固 — 消除已知缺口"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["auth", "security", "jwt", "hardening", "bug-fix"]
createdAt: "2026-06-09T15:03:02.334Z"
updatedAt: "2026-06-09T15:03:08.605Z"
---

# JWT 认证系统安全加固 — 消除已知缺口

Auth 系统核心功能（JWT、bcrypt、OAuth Google+GitHub、axios interceptor、token refresh、URL fragment）已全部完成。本次需求修复 4 个安全缺陷：logout 不撤销 refresh token、cleanup 无 Admin 守卫、PUBLIC_API 死条目、登录时 guest session 未清理。

<!-- TASK_TIER {"tier":"standard","reason":"3 文件修改（service.ts + routes.ts + app.ts）+ 1 测试文件，触及 fast 阈值（≤2 文件）之上，但无新建文件、无 schema 变更、无跨模块依赖"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["requireRole(...roles) middleware — middleware/auth.ts:L211","revokeRefreshToken(token) — service.ts (已导出)","prisma.refreshToken.updateMany where userId — Prisma schema L450 RefreshToken model","prisma.session.deleteMany where userId+guestId — Prisma schema L433 Session model","PUBLIC_API Set — app.ts L78-L98"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ requireRole(...roles) middleware — middleware/auth.ts:L211
- ✅ revokeRefreshToken(token) — service.ts (已导出)
- ✅ prisma.refreshToken.updateMany where userId — Prisma schema L450 RefreshToken model
- ✅ prisma.session.deleteMany where userId+guestId — Prisma schema L433 Session model
- ✅ PUBLIC_API Set — app.ts L78-L98

## AC Groups

### auth-security-hardening
<!-- MODEL_TIER {"tier":"standard","reason":"3 源文件修改，无新建文件，无 schema 变更，均为 auth 模块内部安全修复，但文件数超 fast 阈值"} -->

#### 验收标准
- [ ] AC1: 在 service.ts logout() L262-L267；扩展函数签名为 logout(sessionId: string, userId?: string)；当 userId 存在时调用 prisma.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } }) 撤销该用户所有 refresh token；userId 为空时仅过期 session（向后兼容 guest logout）
- [ ] AC2: 在 routes.ts /cleanup 路由 L164；将 requireAuth() 改为 requireAuth(), requireRole('Admin')；非 Admin 用户触发时返回 403
- [ ] AC3: 在 app.ts PUBLIC_API Set L81；删除死条目 '/auth/session'（无对应路由处理器）
- [ ] AC4: 在 service.ts login() L185 之前；查询该用户现有 guest session（prisma.session.findMany({ where: { userId: user.id, guestId: { isNot: null }, expiresAt: { gt: new Date() } } })），然后 prisma.session.deleteMany({ where: { id: { in: guestSessions.map(s=>s.id) } } })；登录成功后旧 guest session 不再残留
- [ ] AC5: 为 AC1-AC4 编写测试用例；AC1 测试：logout 带 userId 时 refreshToken.revokedAt 被设置；AC2 测试：cleanup 路由对非 Admin 返回 403；AC4 测试：login 后旧 guest session 被删除

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/routes.ts
- apps/api/src/app.ts
- apps/api/src/modules/auth/__tests__/service.test.ts
## 约束
- logout() 签名扩展必须向后兼容（userId? 可选）
- 不引入新 npm 依赖
- 不修改 Prisma schema
- 不改动 axios interceptor 逻辑
- 不改动 OAuth 流程

## AC Groups

```json
[
  {
    "id": "auth-security-hardening",
    "acs": [
      "AC1: 在 service.ts logout() L262-L267；扩展函数签名为 logout(sessionId: string, userId?: string)；当 userId 存在时调用 prisma.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } }) 撤销该用户所有 refresh token；userId 为空时仅过期 session（向后兼容 guest logout）",
      "AC2: 在 routes.ts /cleanup 路由 L164；将 requireAuth() 改为 requireAuth(), requireRole('Admin')；非 Admin 用户触发时返回 403",
      "AC3: 在 app.ts PUBLIC_API Set L81；删除死条目 '/auth/session'（无对应路由处理器）",
      "AC4: 在 service.ts login() L185 之前；查询该用户现有 guest session（prisma.session.findMany({ where: { userId: user.id, guestId: { isNot: null }, expiresAt: { gt: new Date() } } })），然后 prisma.session.deleteMany({ where: { id: { in: guestSessions.map(s=>s.id) } } })；登录成功后旧 guest session 不再残留",
      "AC5: 为 AC1-AC4 编写测试用例；AC1 测试：logout 带 userId 时 refreshToken.revokedAt 被设置；AC2 测试：cleanup 路由对非 Admin 返回 403；AC4 测试：login 后旧 guest session 被删除"
    ],
    "files": [
      "apps/api/src/modules/auth/service.ts",
      "apps/api/src/modules/auth/routes.ts",
      "apps/api/src/app.ts",
      "apps/api/src/modules/auth/__tests__/service.test.ts"
    ],
    "dependencies": [],
    "implementationNotes": "1. service.ts logout(): 当前仅 prisma.session.update expiresAt=now。需扩展签名加 userId? 参数，有 userId 时批量撤销 refreshToken。注意：routes.ts logout handler 已有 authInfo.userId，传入即可。2. routes.ts /cleanup: 在 requireAuth() 后加 requireRole('Admin') 中间件。import { requireRole } from '../../middleware/auth.js'（当前未 import）。3. app.ts: 删除 L81 '/auth/session'。4. service.ts login(): 在 prisma.session.create 前，查 prisma.session.findMany({ where: { userId: user.id, guestId: { isNot: null }, expiresAt: { gt: new Date() } } }) 然后 prisma.session.deleteMany({ where: { id: { in: guestSessions.map(s => s.id) } } })。",
    "architectureContext": {
      "functions": [
        "logout(sessionId: string): Promise<void> @ service.ts:L262",
        "login(input: LoginInput): Promise<AuthResult> @ service.ts:L147",
        "generateRefreshToken(userId: string): Promise<string> @ service.ts:L290",
        "revokeRefreshToken(token: string): Promise<void> @ service.ts:L310",
        "requireRole(...roles: string[]): RequestHandler @ middleware/auth.ts:L211",
        "getAuthInfo(req): {sessionId, userId, anonymousId} @ middleware/auth.ts"
      ],
      "callChain": "POST /logout → requireAuth() → getAuthInfo(req) → authService.logout(sessionId) → prisma.session.update. POST /cleanup → requireAuth() → authService.cleanupExpiredSessions(). POST /login → authService.login(req.body) → prisma.session.create → generateToken → generateRefreshToken.",
      "imports": [
        "import { requireAuth, requireRole, getAuthInfo, optionalAuth } from '../../middleware/auth.js'",
        "import * as authService from './service.js'"
      ],
      "typesInScope": [
        "LoginInput { email: string; password: string } @ service.ts:L19",
        "AuthResult { user?: User; session: Session; token: string; isNewUser?: boolean; refreshToken?: string } @ service.ts:L36",
        "Session { id: string; userId?: string; token: string; guestId?: string; expiresAt: Date } @ prisma schema L433",
        "RefreshToken { id: string; token: string; userId: string; expiresAt: Date; revokedAt?: Date } @ prisma schema L450"
      ],
      "testMock": [
        "vi.mock('@dommaker/studio-prisma', () => ({ prisma: { session: { update: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() }, refreshToken: { updateMany: vi.fn() }, user: { findUnique: vi.fn() } } }))",
        "vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('mock-token'), verify: vi.fn().mockReturnValue({sid:'s1',uid:'u1'}) } }))",
        "vi.mock('bcryptjs', () => ({ default: { hashSync: vi.fn().mockReturnValue('hash'), compareSync: vi.fn().mockReturnValue(true) } }))"
      ],
      "dangerZones": [
        "service.ts L262-L267 logout() — 当前只有 session update，不要改动 prisma.session.update 逻辑本身，只在其后追加 refreshToken 撤销",
        "routes.ts L164 /cleanup — requireAuth() 返回的是 middleware，requireRole() 也是 middleware，需链式调用 [requireAuth(), requireRole('Admin')] 或 app.use 风格",
        "service.ts L185 login() — guest session 清理必须在 session.create 之前执行，否则新 session 可能被误删",
        "routes.ts L2 import — 当前只 import 了 requireAuth, getAuthInfo, optionalAuth，需额外 import requireRole"
      ],
      "verifiedAt": "1781016809281 (analysis timestamp)"
    },
    "codePatterns": [
      "middleware 链式用法参考: routes.ts L121 router.post('/logout', requireAuth(), async (req, res) => {...})",
      "批量更新参考: service.ts revokeRefreshToken() 使用 prisma.refreshToken.update({ where: { token }, data: { revokedAt: new Date() } })",
      "requireRole 用法参考: middleware/auth.ts L211-L225 export function requireRole(...roles: string[]) { return (req, res, next) => { if (!roles.includes(req.user.role)) return res.status(403)... } }"
    ],
    "gotchas": [
      "⚠️ logout() 仅被 routes.ts:124 调用 — 扩展签名时 userId? 必须可选，保持向后兼容",
      "⚠️ /cleanup 路由当前 import 列表 (routes.ts:2) 不含 requireRole — 需新增 import",
      "⚠️ PUBLIC_API Set 使用 req.path 匹配（app.ts:103），删除条目后不影响其他路由",
      "⚠️ login() guest session 清理用 deleteMany 而非逐条 delete — 避免 N+1 查询",
      "⚠️ RefreshToken.revokedAt 已有值时 updateMany 是幂等的 — 重复撤销安全"
    ],
    "modelTier": "standard",
    "modelTierReason": "3 源文件修改，无新建文件，无 schema 变更，均为 auth 模块内部安全修复，但文件数超 fast 阈值"
  }
]
```

## Files

- apps/api/src/app.ts
- apps/api/src/modules/auth/__tests__/service.test.ts
- apps/api/src/modules/auth/routes.ts
- apps/api/src/modules/auth/service.ts