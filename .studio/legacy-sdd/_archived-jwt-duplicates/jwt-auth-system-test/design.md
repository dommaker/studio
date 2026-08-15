---
id: "sdd-1782806674869-ocvkq1"
slug: "jwt-auth-system-test"
title: "JWT 认证系统测试覆盖补全 + 边界加固"
status: "done"
tier: "standard"
version: 5
requirementVersion: 1
designVersion: 5
taskVersion: 1
parentId: "sdd-1782574335958-ec86s8"
changeType: "L3"
createdAt: "2026-06-18T08:18:31.034Z"
updatedAt: "2026-06-30T08:04:34.869Z"
---

## Design

### ac-route-coverage

**Implementation Notes**
路由测试使用 supertest 或直接调用 route handler 函数 + mock Express req/res。auth/routes.ts 导出 default Router，通过 mock auth/service.ts 函数（login/register/logout/getCurrentUser/createGuestSession）和 AuditService 控制测试路径。OAuth routes 需要 mock cookie-parser 注入 req.cookies 和 oauth.service.ts 函数。速率限制验证用 mock express-rate-limit 或检查中间件配置。

**Architecture Context**
- Functions: auth/routes.ts default export: Router with POST /guest-session, POST /register, POST /login, POST /logout, GET /me, POST /refresh, POST /cleanup, oauth/routes.ts default export: Router with GET /:provider(google|github), GET /callback/:provider(google|github), authRateLimit: RateLimitRequestHandler (express-rate-limit, windowMs=60s, max=10), refreshRateLimit: RateLimitRequestHandler (express-rate-limit, windowMs=60s, max=20)
- Call Chain: route-registry.ts:buildRouteTable → auth/routes.ts + oauth/routes.ts → auth/service.ts + oauth.service.ts + middleware chain
- Imports: import { requireAuth, getAuthInfo, optionalAuth, requireRole } from '../../middleware/auth.js', import { authRateLimit, refreshRateLimit } from '../../middleware/rate-limit.js', import { AuditService } from '@dommaker/studio-audit', import * as authService from '../../modules/auth/service.js', import * as oauthService from '../../modules/auth/oauth.service.js'
- Danger Zones: oauth.routes.ts:L57 — CSRF state 验证: cookie clear 后才比较, 若 clearCookie 失败则比较永远为 true（宽松但非漏洞）, route-registry.ts:L164-165 — authRoutes + oauthRoutes 都挂载在 /api/v1/auth, 新增端点注意路径冲突
- Verified At: 无路由级单元测试；auth-flow.e2e.test.ts:147 行间接覆盖端点调用

**Code Patterns**
- Express Router + 中间件数组模式: router.post('/path', [middleware1, middleware2], handler)

**Gotchas**
- requireAuth/optionalAuth/requireRole 是中间件工厂（返回函数），调用时必须加括号: requireAuth() 不是 requireAuth
- oauth callback URL 路径为 /callback/:provider，非 /:provider/callback

### ac-middleware-ext-coverage

**Implementation Notes**
workspaceAuth 验证 Bearer token → sha256 hash → prisma.workspaceToken.findUnique（include workspace）→ 注入 req.workspace/req.workspaceToken。失败返回 401。checkOwnership 通过 (prisma as any)[model].findUnique 动态查询，检查 owner/creator 字段匹配 userId，Admin 跳过。requireNotGuest 简单检查 req.user.role !== 'Guest'。generateAnonymousId 为 crypto.createHash('sha256').update(ip+ua+date).digest('hex')。

**Architecture Context**
- Functions: workspaceAuth(): (req: AuthRequest, res: Response, next: NextFunction) => Promise<void> @ middleware/auth.ts:328-383, checkOwnership(model: string, paramKey?: string): (req: AuthRequest, res: Response, next: NextFunction) => Promise<void> @ middleware/auth.ts:247-303, requireNotGuest(): (req: AuthRequest, res: Response, next: NextFunction) => void @ middleware/auth.ts:308-321, generateAnonymousId(req: Request): string @ middleware/auth.ts:56-62
- Call Chain: route handler → requireAuth() → requireNotGuest() → handler; workspaceAuth 用于 Daemon 端点; checkOwnership 用于资源操作端点
- Imports: import { prisma } from '@dommaker/studio-prisma', import crypto from 'crypto', import { verifyToken } from '../modules/auth/service.js'
- Danger Zones: middleware/auth.ts:L274 — (prisma as any)[model].findUnique: 传入无效 model 名导致运行时 prisma.undefinedModel 错误, middleware/auth.ts:L56-62 — generateAnonymousId 算法变更会破坏匿名 ID 一致性（SEC-009）
- Verified At: 无独立单元测试；通过集成测试间接覆盖

**Code Patterns**
- 中间件工厂模式: 所有中间件返回 (req, res, next) => void 闭包，支持参数化配置

**Gotchas**
- checkOwnership 使用 (prisma as any)[model] 违反 no_any_type — 需改为类型安全的 model 映射表
- workspaceAuth 的 token hash 使用 sha256，与 JWT 签名算法（HS256）不同——这是 workspace token 验证，非用户认证

### ac-rate-limit-tests

**Implementation Notes**
rate-limit.ts 导出 authRateLimit 和 refreshRateLimit 两个 express-rate-limit 中间件实例（非工厂函数）。测试验证其配置（windowMs、max、message、standardHeaders、legacyHeaders）与项目其他限流器（mcpRateLimit、apiRateLimit）风格一致。

**Architecture Context**
- Functions: authRateLimit — rateLimit({ windowMs: 60*1000, max: 10, ... }), refreshRateLimit — rateLimit({ windowMs: 60*1000, max: 20, ... })
- Call Chain: auth/routes.ts 端点 → [authRateLimit, handler] 或 [refreshRateLimit, handler]
- Imports: import rateLimit from 'express-rate-limit'
- Danger Zones: N/A
- Verified At: 无独立单元测试；集成在 auth endpoint E2E 中间接覆盖

**Code Patterns**
- express-rate-limit 内存 store 模式: 与 mcpRateLimit/apiRateLimit 风格一致

**Gotchas**
- authRateLimit 阈值 10/min 不可随意放松——需安全评审
- 内存 store 在服务器重启后清零——生产环境需评估是否换成 Redis store

### ac-oauth-exchange

**Implementation Notes**
OAuth exchange 使用 native fetch（非 axios 或 passport）。exchangeGoogleCode 调用 https://oauth2.googleapis.com/token → https://www.googleapis.com/oauth2/v2/userinfo。exchangeGitHubCode 调用 https://github.com/login/oauth/access_token → https://api.github.com/user → https://api.github.com/user/emails（fallback 获取 primary verified email）。测试使用 vi.mock('node-fetch') 或 nock 拦截 HTTP 请求。

**Architecture Context**
- Functions: exchangeCodeForTokens(provider: OAuthProvider, code: string): Promise<{ profile: OAuthProfile; tokens: OAuthTokens }> @ oauth.service.ts:68-80, exchangeGoogleCode(code: string): Promise<{ profile; tokens }> — private, exchangeGitHubCode(code: string): Promise<{ profile; tokens }> — private, getOrCreateOAuthUser(provider: OAuthProvider, profile: OAuthProfile, tokens: OAuthTokens): Promise<{ user: User }> @ oauth.service.ts:232-311, createOAuthSession(userId: string, req: Request): Promise<{ token: string; refreshToken: string; session: Session }> @ oauth.service.ts:316-353
- Call Chain: GET /auth/callback/:provider → oauth/routes.ts → oauth/service.ts:exchangeCodeForTokens → fetch(token endpoint) → fetch(profile endpoint) → getOrCreateOAuthUser → createOAuthSession → redirect with #fragment
- Imports: import { JWT_SECRET, generateRefreshToken } from './service.js', import { prisma } from '@dommaker/studio-prisma', import jwt from 'jsonwebtoken'
- Danger Zones: oauth.service.ts:L68-80 — exchangeCodeForTokens 仅分发到 private 函数，无独立 HTTP 错误处理, GitHub email fallback: /user/emails 返回数组，需找 primary && verified 的 email；若用户无 verified email 则登录失败
- Verified At: apps/api/src/modules/auth/__tests__/oauth.service.test.ts:258 行 — 仅覆盖 unsupported provider，空 describe blocks for Google/GitHub exchange (L120, L180)

**Code Patterns**
- OAuth2 native fetch 模式: 无 passport.js 依赖，手工构建 URL + fetch + JSON.parse

**Gotchas**
- GitHub OAuth token endpoint 返回 URL-encoded 格式（非 JSON）：access_token=xxx&scope=user:email&token_type=bearer
- Google userinfo endpoint 返回 email_verified 字段，需验证其为 true
- OAuth token 通过 URL fragment (#) 传递——测试需验证 redirect URL 包含 #access_token=...&refresh_token=...

### ac-refresh-concurrency

**Implementation Notes**
exchangeRefreshToken 非事务包裹：先 updateMany 吊销旧 token → prisma.refreshToken.findUnique 验证 → prisma.session.create → jwt.sign → prisma.refreshToken.create。并发场景下两个请求可能同时通过吊销检查（updateMany 成功 twice），需验证第二个请求在 findUnique 时看到 revokedAt 已设置。前端 interceptor 使用模块级 isRefreshing flag + failedQueue 数组实现并发 401 排队。

**Architecture Context**
- Functions: exchangeRefreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; userId: string } | null> @ service.ts:341-372, revokeRefreshToken(refreshToken: string): Promise<boolean> @ service.ts:377-392, generateRefreshToken(userId: string): Promise<string> @ service.ts:326-336, api.interceptors.response (401) @ web/api/index.ts:70-130, refreshToken(refreshTokenValue: string) @ web/api/index.ts:64-67
- Call Chain: axios response interceptor (401) → getStoredAuth() → refreshToken() → POST /auth/refresh → service.ts:exchangeRefreshToken → updateMany(revoke) → findUnique(verify) → create(session+token)
- Imports: import { prisma } from '@dommaker/studio-prisma', import jwt from 'jsonwebtoken', import axios from 'axios'
- Danger Zones: service.ts:L341-L372 — exchangeRefreshToken: 非事务包裹，并发场景可能重复消费同一 refresh token。findUnique 在 updateMany 之后，若另一并发请求在 findUnique 前完成 updateMany，当前请求的 findUnique 返回 revokedAt!=null → 返回 null（安全，不会双发 token）, web/api/index.ts:L49-L50 — isRefreshing/failedQueue 为模块级变量，多 tab 不共享状态
- Verified At: apps/api/src/modules/auth/__tests__/service.test.ts:334-404 — 单线程 exchangeRefreshToken 测试（revoked/expired/nonexistent/valid），无并发测试

**Code Patterns**
- Refresh Token Rotation: 吊销旧 → 创建新（access + refresh），非事务但通过 updateMany(revokedAt) + findUnique 检查实现幂等
- Axios interceptor 并发队列: isRefreshing flag + failedQueue = [{ resolve, reject, config }] → token 刷新后 flush

**Gotchas**
- exchangeRefreshToken 的第 2 步 findUnique 在 updateMany 之后——这提供了一种乐观并发控制（revokedAt 检查）
- 前端 failedQueue 中的请求按序重试（FIFO）——需确认重试请求使用新 token

### ac-frontend-coverage

**Implementation Notes**
authStore.ts 使用 Zustand 状态管理，含 user/session/token/refreshToken/isLoading 状态 + login/register/logout/refreshToken/getCurrentUser/clearAuth actions。OAuthCallback.tsx 在 useEffect 中解析 window.location.hash → 提取 access_token/refresh_token → 调用 authStore.setAuth → router.push('/')。axios interceptor 从 localStorage 直接读 token（不 import authStore 避免循环依赖）。

**Architecture Context**
- Functions: useAuthStore() — Zustand store hook @ authStore.ts:5-215, OAuthCallback() — React component @ OAuthCallback.tsx:1-50, api.interceptors.request (Bearer inject) @ web/api/index.ts:30-45, api.interceptors.response (401 catch) @ web/api/index.ts:70-130
- Call Chain: App → OAuthCallback → useEffect → parseHash → authStore.setAuth → redirect; Any API call → axios request interceptor → getStoredAuth() → inject Bearer; 401 → response interceptor → refreshToken() → retry
- Imports: import { create } from 'zustand', import axios from 'axios'
- Danger Zones: web/api/index.ts:L49-L50 — isRefreshing/failedQueue 模块级变量：SSR 或多 tab 竞态, OAuthCallback.tsx: hash 解析后未验证 token 格式即存储——恶意 hash 可注入无效 token
- Verified At: 无独立单元测试；authStore.ts 215行零测试；OAuthCallback.tsx 50行零测试；interceptor 通过 api-interceptor.test.ts + interceptor.test.ts 部分覆盖

**Code Patterns**
- Zustand store: create<AuthState & AuthActions>((set, get) => ({ ...actions }))
- Axios interceptor 直接读 localStorage: 避免 import authStore 导致的循环依赖

**Gotchas**
- authStore 的 refreshToken action 读取 localStorage 中的 refreshToken，非 store 中的 refreshToken 字段——不一致的 token 来源可能导致过期 token 被使用
- OAuthCallback 组件无 loading/error 状态展示——OAuth 回调失败时用户看不到任何反馈

### ac-audit-logger

**Implementation Notes**
audit-logger.ts 为 Express 中间件，拦截特定路由（login/register/logout/role-change）记录审计日志到 AuditService。日志包含 action、userId、ip、userAgent、timestamp、metadata。测试需 mock AuditService 并验证 log() 被调用时的参数正确性。

**Architecture Context**
- Functions: auditLogger(action: string): (req: AuthRequest, res: Response, next: NextFunction) => void @ audit-logger.ts, AuditService.log(entry: AuditEntry): Promise<void> — 外部服务
- Call Chain: routes.ts handler → requireAuth → auditLogger → handler → AuditService.log
- Imports: import { AuditService } from '@dommaker/studio-audit', import { AuthRequest } from './auth.js'
- Danger Zones: N/A
- Verified At: 无独立单元测试；审计日志通过 auth-flow.e2e.test.ts 间接验证

**Code Patterns**
- Express 中间件包装: auditLogger('LOGIN') 返回 (req, res, next) => { ... AuditService.log(...); next(); }

**Gotchas**
- 审计日志为 fire-and-forget 模式（不等待 log 完成即 next()）——日志写入失败不影响用户请求但可能丢失审计记录

### ac-password-migration

**Implementation Notes**
verifyPassword 通过格式检测区分 bcrypt（$2a$/$2b$ 前缀）和旧 PBKDF2（hex salt:hex hash 格式）。旧格式验证：crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex') 与存储 hash 比较。匹配时返回 { valid: true, needsRehash: true }，login 流程检测 needsRehash 后调用 hashPassword 升级为 bcrypt 并 prisma.user.update。

**Architecture Context**
- Functions: verifyPassword(password: string, storedHash: string): { valid: boolean; needsRehash: boolean } @ service.ts:56-70, hashPassword(password: string): Promise<string> @ service.ts:47-49, login(input: LoginInput): Promise<AuthResult> @ service.ts:151-217 — L180-186 needsRehash 分支
- Call Chain: POST /auth/login → service.ts:login → verifyPassword → (needsRehash) → hashPassword(bcrypt) → prisma.user.update
- Imports: import bcrypt from 'bcryptjs', import * as crypto from 'crypto'
- Danger Zones: service.ts:L56-L70 — verifyPassword: PBKDF2 旧格式兼容逻辑，删除前需确认 DB 中无旧格式 hash 残留, PBKDF2 参数（iterations=10000, keylen=64, digest=sha512）不可变更——需与历史数据匹配
- Verified At: 无独立单元测试；通过 login 集成测试间接覆盖（仅 bcrypt 路径，PBKDF2 路径无测试）

**Code Patterns**
- 密码静默升级: 旧格式验证通过 → needsRehash flag → login 流程中自动 update passwordHash 为新 bcrypt 哈希

**Gotchas**
- 旧 PBKDF2 格式识别依赖 hex 格式前缀检测——若 bcrypt hash 以 ':' 分隔则可能误识别
- 静默升级为同步写操作——在 login 响应返回前完成 user.update，慢查询可能影响登录响应时间

### ac-no-any-cleanup

**Implementation Notes**
auth 测试文件广泛使用 as any 绕过类型检查（service.test.ts ~20处、oauth.service.test.ts ~15处、middleware-invocation.test.ts ~10处）。需逐文件消除：mock 对象使用 satisfies Prisma 类型或具体接口类型，而非 as any 强制转换。middleware/auth.ts L274 的 (prisma as any)[model] 改为 Record<string, PrismaDelegate> 映射表。

**Architecture Context**
- Functions: checkOwnership(model: string, paramKey?: string) @ middleware/auth.ts:247-303 — L274 (prisma as any)[model]
- Call Chain: N/A — 类型安全改进，不改运行时行为
- Imports: import { Prisma, PrismaClient } from '@prisma/client', import { prisma } from '@dommaker/studio-prisma'
- Danger Zones: 消除 as any 时若 mock 类型不完整可能导致测试编译失败——需逐个文件处理并运行 tsc --noEmit 验证, checkOwnership 的 model 参数为运行时动态值，类型安全的映射表需维护 model 名列表
- Verified At: 全项目 tsc --noEmit 当前通过（as any 绕过导致类型检查实际不完全）

**Code Patterns**
- 类型安全 model 映射: const modelDelegates = { user: prisma.user, channel: prisma.channel, goal: prisma.goal } as const

**Gotchas**
- 消除 as any 后测试 mock 的 Prisma 对象类型需与真实 Prisma 类型匹配——部分 mock 可能简化为 vi.fn() 但实际类型有 select/include 泛型参数，需使用 vi.fn<Parameters<typeof prisma.user.findUnique>>() 类型推断