---
id: "cmqj74ncd01yjmekjrvuj9nwa"
slug: "jwt-authentication-system-with-token-refresh-and-o"
title: "JWT Authentication System with Token Refresh and OAuth2.0 Third-Party Login"
status: "done"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
createdAt: "2026-06-18T07:46:22.759Z"
updatedAt: "2026-06-18T07:46:22.759Z"
---

## Design

### acg-auth-routes

**Implementation Notes**
routes.ts 中每个 handler 遵循 Express (req, res) => void 模式。handler 调用 authService 对应方法，捕获异常后映射为 HTTP 状态码（401/403/409/500）。auditService 在敏感操作（login/logout/register）前后记录审计日志。测试需 mock authService + auditService + rateLimiter，验证 handler 直接返回的 status/json 调用。复用 service.test.ts 中的 prisma mock 模式。

**Architecture Context**
- Functions: createGuestSessionHandler(req: Request, res: Response): Promise<void>, registerHandler(req: Request, res: Response): Promise<void>, loginHandler(req: Request, res: Response): Promise<void>, logoutHandler(req: Request, res: Response): Promise<void>, getCurrentUserHandler(req: Request, res: Response): Promise<void>, cleanupExpiredSessionsHandler(req: Request, res: Response): Promise<void>, refreshTokenHandler(req: Request, res: Response): Promise<void>
- Call Chain: Express Router -> handler -> authService.method() -> prisma -> response; 错误路径: handler catch -> mapErrorToStatus() -> res.status(code).json({ error, code })
- Imports: authService from '../service.js', auditService from '../../../services/audit.js', rateLimiter from '../middleware/rate-limit.js', logger from '@dommaker/studio-shared', Request, Response from 'express'
- Danger Zones: auditService.log 调用失败不应阻断主流程（fire-and-forget）, 错误码映射需与 service 层抛出的错误类型严格对应, rate-limit 中间件配置（窗口大小、最大请求数）直接影响用户体验
- Verified At: apps/api/src/modules/auth/__tests__/service.test.ts — 已有 prisma + studio-shared + logger mock 模式

**Code Patterns**
- Express handler: async (req, res) => { try { ... } catch (err) { res.status(mapError(err)).json(...) } }
- Mock 复用: service.test.ts 的 vi.mock('@dommaker/studio-prisma') 和 vi.mock('@dommaker/studio-shared') 模板

**Gotchas**
- auditService 是 fire-and-forget — 测试中不能 await 其调用，需用 waitFor 或 setTimeout
- rate-limit 中间件在集成测试中可能因请求频率过高返回 429，单元测试应 mock 掉
- refresh token handler 需要同时处理 cookie 和 Authorization header 两种传递方式

### acg-oauth-routes

**Implementation Notes**
oauth.routes.ts 处理 OAuth2.0 授权码流程：GET /:provider → 生成 state + 设置 cookie → 302 redirect 到 provider 授权页；GET /:provider/callback → 验证 state cookie → exchangeCodeForTokens → getOrCreateOAuthUser → createOAuthSession → 302 redirect 到前端。CSRF 防护依赖 state cookie 比对。测试需 mock oauthService + cookie 操作。

**Architecture Context**
- Functions: oauthRedirectHandler(req: Request, res: Response): Promise<void>, oauthCallbackHandler(req: Request, res: Response): Promise<void>
- Call Chain: GET /:provider -> oauthRedirectHandler -> oauthService.getAuthorizationUrl() -> res.cookie('oauth_state', ...) -> res.redirect(authUrl); GET /:provider/callback -> oauthCallbackHandler -> verifyStateCookie() -> oauthService.exchangeCodeForTokens() -> oauthService.getOrCreateOAuthUser() -> oauthService.createOAuthSession() -> res.redirect(frontendUrl)
- Imports: oauthService from '../oauth.service.js', crypto (randomBytes for state generation), cookie-parser middleware, Request, Response from 'express'
- Danger Zones: CSRF state cookie 必须设置 SameSite=Lax, HttpOnly, Secure（生产环境）, state 参数过期时间控制（建议 10 分钟）, callback 路由必须验证 state 匹配，否则攻击者可伪造 OAuth 回调, redirect URL 白名单校验（防止 open redirect 漏洞）
- Verified At: apps/api/src/modules/auth/__tests__/oauth.service.test.ts — OAuth service 层已测试 getAuthorizationUrl/getOrCreateOAuthUser/createOAuthSession

**Code Patterns**
- state generation: crypto.randomBytes(32).toString('hex')
- cookie set: res.cookie('oauth_state', state, { maxAge: 600000, httpOnly: true, sameSite: 'lax' })
- redirect after auth: res.redirect(302, FRONTEND_CALLBACK_URL + '?token=' + jwtToken)

**Gotchas**
- GitHub OAuth 用 POST 请求 access_token endpoint，Google 用 POST + form-urlencoded
- callback 中 state cookie 验证后应立即清除（防止重放）
- 测试中 mock cookie 需同时处理 req.cookies 读取和 res.cookie 写入

### acg-middleware-remaining

**Implementation Notes**
middleware/auth.ts 中 checkOwnership/requireNotGuest/workspaceAuth 遵循 Express middleware 签名 (req, res, next)。checkOwnership 验证 req.user.id 与资源 ownerId 匹配；requireNotGuest 检查 req.user.role !== 'guest'；workspaceAuth 验证 req.user.workspaceId 与目标 workspace 一致。generateAnonymousId 生成 UUID 格式的匿名标识符。测试复用 middleware-invocation.test.ts 的 mock 模式（mock verifyToken + prisma session）。

**Architecture Context**
- Functions: checkOwnership(resourceIdParam: string): (req: Request, res: Response, next: NextFunction) => void, requireNotGuest(req: Request, res: Response, next: NextFunction): void, workspaceAuth(workspaceIdParam: string): (req: Request, res: Response, next: NextFunction) => void, generateAnonymousId(): string
- Call Chain: Express middleware chain: requireAuth -> checkOwnership('userId') -> controller; 或 requireAuth -> requireNotGuest -> workspaceAuth('workspaceId') -> controller
- Imports: verifyToken from '../service.js' (for token extraction), prisma from '@dommaker/studio-prisma' (for session/resource lookup), logger from '@dommaker/studio-shared', Request, Response, NextFunction from 'express', crypto (for generateAnonymousId)
- Danger Zones: checkOwnership 若 resourceId 对应的资源不存在应返回 404 而非 403, requireNotGuest 应与 requireAuth 组合使用，单独使用 req.user 可能为 undefined, workspaceAuth 在跨 workspace 访问场景下需考虑 admin 角色的特权绕过
- Verified At: apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts — requireAuth/optionalAuth/requireRole 已有工厂函数测试模式可复用

**Code Patterns**
- Middleware factory: export const checkOwnership = (paramName: string) => async (req, res, next) => { ... }
- Error response: res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' })
- generateAnonymousId: crypto.randomUUID() or crypto.randomBytes(16).toString('hex')

**Gotchas**
- checkOwnership 工厂函数返回 async middleware，需在测试中 await 调用
- workspaceAuth 的 workspaceId 可能来自 req.params / req.body / req.user，需确认提取逻辑
- generateAnonymousId 的格式需要与 session/user 存储中的字段类型匹配

### acg-service-edge

**Implementation Notes**
service.ts 的 getOrCreateSession 处理并发登录和设备管理；cleanupExpiredSessions 是定时任务调用的批量清理函数；verifyPassword 需兼容旧 PBKDF2 格式（格式标识前缀不同）；hashPassword 输出 bcrypt $2b$ 格式。测试复用 service.test.ts 的完整 mock 基础设施（prisma + jsonwebtoken + studio-shared + logger）。

**Architecture Context**
- Functions: getOrCreateSession(userId: string, deviceInfo: string): Promise<Session>, cleanupExpiredSessions(): Promise<{ deletedCount: number }>, verifyPassword(plaintext: string, hash: string): Promise<boolean>, hashPassword(plaintext: string): Promise<string>
- Call Chain: getOrCreateSession: prisma.session.findFirst({ where: { userId, deviceInfo } }) -> if not found: prisma.session.create({ data: { userId, deviceInfo, token, expiresAt } }) -> return session; cleanupExpiredSessions: prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }); verifyPassword: 检测 hash 前缀 -> bcrypt (starts with $2b$) or PBKDF2 (starts with $pbkdf2$) -> 如果需要 rehash 则标记; hashPassword: bcrypt.hash(plaintext, SALT_ROUNDS)
- Imports: prisma from '@dommaker/studio-prisma', bcrypt from 'bcrypt', crypto from 'crypto' (PBKDF2 path), jsonwebtoken from 'jsonwebtoken', logger from '@dommaker/studio-shared', JWT_SECRET from env
- Danger Zones: PBKDF2 旧格式兼容路径 — 若 detectHashFormat 逻辑错误，旧用户无法登录, cleanupExpiredSessions 批量删除可能影响大量记录，需确认 prisma.deleteMany 的事务行为, hashPassword 的 SALT_ROUNDS 值影响安全性与性能平衡（建议 10-12）, getOrCreateSession 在并发登录时可能创建重复 session（需 unique constraint 防护）
- Verified At: apps/api/src/modules/auth/__tests__/service.test.ts — 已有完整的 prisma + jwt + bcrypt mock 基础设施

**Code Patterns**
- Password verify dispatch: if (hash.startsWith('$2b$')) { return bcrypt.compare(plaintext, hash) } else if (hash.startsWith('$pbkdf2$')) { return verifyPBKDF2(plaintext, hash) }
- Session create: { userId, token: jwt.sign({ userId, sessionId }, JWT_SECRET, { expiresIn }), deviceInfo, expiresAt: addDays(new Date(), 7) }
- Cleanup: prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })

**Gotchas**
- bcrypt.compare 返回 Promise<boolean>，PBKDF2 verify 需自行实现 timingSafeEqual 防时序攻击
- getOrCreateSession 应使用 prisma 的 upsert 或事务来避免 race condition
- cleanupExpiredSessions 需在测试中 mock prisma.session.deleteMany 返回 { count: N }

### acg-oauth-exchange

**Implementation Notes**
exchangeCodeForTokens 是 OAuth2.0 授权码流程核心函数：使用 fetch() 向 Google token endpoint (https://oauth2.googleapis.com/token) 或 GitHub token endpoint (https://github.com/login/oauth/access_token) 交换 access_token。当前仅测试了 unsupported provider 的 throw 路径，需补充 mock fetch 测试 Google/GitHub 实际 HTTP 请求/响应。

**Architecture Context**
- Functions: exchangeCodeForTokens(provider: OAuthProvider, code: string, redirectUri: string): Promise<OAuthTokenResponse>, getGoogleUserProfile(accessToken: string): Promise<OAuthUserProfile>, getGitHubUserProfile(accessToken: string): Promise<OAuthUserProfile>
- Call Chain: exchangeCodeForTokens -> switch(provider) -> Google: POST https://oauth2.googleapis.com/token { code, client_id, client_secret, redirect_uri, grant_type: 'authorization_code' } -> parse response { access_token, id_token } -> getGoogleUserProfile(accessToken); GitHub: POST https://github.com/login/oauth/access_token { code, client_id, client_secret } + Accept: application/json -> parse response -> getGitHubUserProfile(accessToken)
- Imports: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET from env, global fetch (Node 18+), logger from '@dommaker/studio-shared'
- Danger Zones: Google OAuth 返回 id_token (JWT) 需要解码验证，GitHub 直接返回 access_token, client_secret 在请求体中传递，日志输出必须脱敏, fetch 超时处理（建议 AbortController + 10s timeout）, GitHub token endpoint 要求 Accept: application/json header，否则返回 URL-encoded
- Verified At: apps/api/src/modules/auth/__tests__/oauth.service.test.ts — 已有 unsupported provider throw 路径测试

**Code Patterns**
- Google token exchange: fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id, client_secret, redirect_uri, grant_type: 'authorization_code' }) })
- GitHub token exchange: fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ code, client_id, client_secret }) })
- User profile fetch: fetch(providerApiUrl, { headers: { Authorization: 'Bearer ' + accessToken } })

**Gotchas**
- Node 18+ 原生 fetch 在测试中可用 vi.spyOn(global, 'fetch') mock，无需额外依赖
- Google 的 id_token 包含用户信息（JWT），可直接解码获取 email/name，无需额外 API 调用
- GitHub 获取用户信息需额外请求 GET https://api.github.com/user，获取 email 需 GET https://api.github.com/user/emails
- 测试 fetch mock 需分别处理 token exchange 和 user profile 两次 HTTP 调用
