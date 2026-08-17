<!-- GATE_REVISION_ATTEMPT 2 -->
```json
{
  "requirement": {
    "title": "JWT Authentication System with Token Refresh and OAuth2.0 Third-Party Login",
    "summary": "实现基于JWT的用户认证系统，包含：用户注册/登录/登出、guest session创建、access token签发与验证、refresh token轮换机制、OAuth2.0第三方登录（Google/GitHub）、会话生命周期管理。核心service层已实现并通过单元测试，缺口集中在路由层测试、中间件补充测试、OAuth token交换的具体provider路径测试、service边界情况测试。",
    "tier": "standard",
    "tierReason": "认证系统涉及JWT签发/验证、refresh token轮换、OAuth2.0协议实现、CSRF防护等安全关键环节，需完整的测试覆盖（含路由层集成测试和provider实际调用路径）。不属于premium（无跨系统分布式认证需求），也不属于fast（不能仅凭service层单元测试就声称完成）。",
    "acGroups": [
      {
        "id": "acg-auth-routes",
        "acs": [
          "为 routes.ts 的全部 handler（guest-session/register/login/logout/me/cleanup/refresh）编写单元测试，覆盖正常路径和错误码映射",
          "验证 auditService (SEC-010) 在 login/logout/register 操作中被正确调用",
          "测试 rate-limit 中间件在路由层的集成行为",
          "确认所有 handler 的错误响应格式一致（{ error: string, code: string }）"
        ],
        "files": [
          "apps/api/src/modules/auth/routes.ts",
          "apps/api/src/modules/auth/__tests__/routes.test.ts"
        ],
        "dependencies": [
          "acg-auth-service-edge"
        ]
      },
      {
        "id": "acg-oauth-routes",
        "acs": [
          "为 oauth.routes.ts 的 provider redirect handler 和 callback handler 编写单元测试",
          "测试 CSRF state 校验逻辑（state 不匹配时拒绝请求）",
          "测试 state cookie 的设置和读取（SameSite/HttpOnly/Secure 属性）",
          "测试 OAuth callback 成功后 redirect URL 构建逻辑"
        ],
        "files": [
          "apps/api/src/modules/auth/oauth.routes.ts",
          "apps/api/src/modules/auth/__tests__/oauth.routes.test.ts"
        ],
        "dependencies": [
          "acg-oauth-exchange"
        ]
      },
      {
        "id": "acg-middleware-remaining",
        "acs": [
          "为 checkOwnership 编写单元测试（资源所有权验证逻辑）",
          "为 requireNotGuest 编写单元测试（guest 用户拦截）",
          "为 workspaceAuth 编写单元测试（workspace 级别权限控制）",
          "为 generateAnonymousId 编写单元测试（匿名 ID 生成格式和唯一性）"
        ],
        "files": [
          "apps/api/src/middleware/auth.ts",
          "apps/api/src/modules/auth/__tests__/middleware-auth.test.ts"
        ],
        "dependencies": []
      },
      {
        "id": "acg-service-edge",
        "acs": [
          "为 getOrCreateSession 编写单元测试（新建 session 和复用已有 session 两条路径）",
          "为 cleanupExpiredSessions 编写单元测试（过期 session 清理、批量删除验证）",
          "为 verifyPassword 的 PBKDF2 旧格式路径编写单元测试（兼容老密码哈希）",
          "为 hashPassword 编写单元测试（输出 bcrypt 格式验证、salt 随机性）"
        ],
        "files": [
          "apps/api/src/modules/auth/service.ts",
          "apps/api/src/modules/auth/__tests__/service-edge.test.ts"
        ],
        "dependencies": []
      },
      {
        "id": "acg-oauth-exchange",
        "acs": [
          "为 exchangeCodeForTokens 的 Google provider 路径编写单元测试（mock fetch 模拟令牌交换）",
          "为 exchangeCodeForTokens 的 GitHub provider 路径编写单元测试（mock fetch 模拟令牌交换）",
          "测试 access_token 解析和用户信息获取流程",
          "测试 exchange 失败时的错误处理（无效 code、网络超时、provider 返回错误）"
        ],
        "files": [
          "apps/api/src/modules/auth/oauth.service.ts",
          "apps/api/src/modules/auth/__tests__/oauth.service.test.ts"
        ],
        "dependencies": []
      }
    ],
    "constraints": [
      "JWT secret 通过环境变量提供，禁止硬编码",
      "refresh token 必须支持轮换（rotation）和重用检测",
      "OAuth state 参数必须使用 CSRF token 防护",
      "密码存储使用 bcrypt，兼容旧 PBKDF2 格式的静默升级",
      "所有错误响应格式统一为 { error: string, code: string }",
      "测试覆盖率不低于 80%"
    ],
    "tags": [
      "auth",
      "jwt",
      "oauth2",
      "security",
      "test-coverage"
    ]
  },
  "design": {
    "acGroups": [
      {
        "id": "acg-auth-routes",
        "implementationNotes": "routes.ts 中每个 handler 遵循 Express (req, res) => void 模式。handler 调用 authService 对应方法，捕获异常后映射为 HTTP 状态码（401/403/409/500）。auditService 在敏感操作（login/logout/register）前后记录审计日志。测试需 mock authService + AuditService + rateLimiter，验证 handler 直接返回的 status/json 调用。复用 service.test.ts 中的 prisma mock 模式。",
        "architectureContext": {
          "functions": [
            "createGuestSessionHandler(req: Request, res: Response): Promise<void>",
            "registerHandler(req: Request, res: Response): Promise<void>",
            "loginHandler(req: Request, res: Response): Promise<void>",
            "logoutHandler(req: Request, res: Response): Promise<void>",
            "getCurrentUserHandler(req: Request, res: Response): Promise<void>",
            "cleanupExpiredSessionsHandler(req: Request, res: Response): Promise<void>",
            "refreshTokenHandler(req: Request, res: Response): Promise<void>"
          ],
          "callChain": "Express Router -> handler -> authService.method() -> prisma -> response; 错误路径: handler catch -> mapErrorToStatus() -> res.status(code).json({ error, code })",
          "imports": [
            "authService from './service.js'",
            "AuditService from '@dommaker/studio-audit' (instantiated as new AuditService(prisma))",
            "rateLimiter from '../../middleware/rate-limit.js'",
            "logger from '@dommaker/studio-shared'",
            "Request, Response from 'express'"
          ],
          "typesInScope": [
            "Express Request (含 req.user?: { id, role, workspaceId })",
            "Express Response",
            "AuthError { message: string, code: string, status: number }",
            "AuditEvent { action: string, userId: string, metadata: Record<string, unknown> }"
          ],
          "testMock": [
            "vi.mock('./service.js', () => ({ authService: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), refreshToken: vi.fn(), createGuestSession: vi.fn(), getCurrentUser: vi.fn(), cleanupExpiredSessions: vi.fn(), getOrCreateSession: vi.fn() } }))",
            "vi.mock('@dommaker/studio-audit', () => ({ AuditService: vi.fn().mockImplementation(() => ({ log: vi.fn() })) }))",
            "vi.mock('@dommaker/studio-shared', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))"
          ],
          "dangerZones": [
            "auditService.log 调用失败不应阻断主流程（fire-and-forget）",
            "错误码映射需与 service 层抛出的错误类型严格对应",
            "rate-limit 中间件配置（窗口大小、最大请求数）直接影响用户体验"
          ],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/service.test.ts — 已有 prisma + studio-shared + logger mock 模式。routes.ts 实际导入 AuditService from '@dommaker/studio-audit'，非本地 ../../../services/audit.js 路径。"
        },
        "codePatterns": [
          "Express handler: async (req, res) => { try { ... } catch (err) { res.status(mapError(err)).json(...) } }",
          "Mock 复用: service.test.ts 的 vi.mock('@dommaker/studio-prisma') 和 vi.mock('@dommaker/studio-shared') 模板"
        ],
        "gotchas": [
          "auditService 是 fire-and-forget — 测试中不能 await 其调用，需用 waitFor 或 setTimeout",
          "rate-limit 中间件在集成测试中可能因请求频率过高返回 429，单元测试应 mock 掉",
          "refresh token handler 需要同时处理 cookie 和 Authorization header 两种传递方式"
        ],
        "modelTier": "fast"
      },
      {
        "id": "acg-oauth-routes",
        "implementationNotes": "oauth.routes.ts 处理 OAuth2.0 授权码流程：GET /:provider → 生成 state + 设置 cookie → 302 redirect 到 provider 授权页；GET /:provider/callback → 验证 state cookie → exchangeCodeForTokens → getOrCreateOAuthUser → createOAuthSession → 302 redirect 到前端。CSRF 防护依赖 state cookie 比对。测试需 mock oauthService + cookie 操作。",
        "architectureContext": {
          "functions": [
            "oauthRedirectHandler(req: Request, res: Response): Promise<void>",
            "oauthCallbackHandler(req: Request, res: Response): Promise<void>"
          ],
          "callChain": "GET /:provider -> oauthRedirectHandler -> oauthService.getAuthorizationUrl() -> res.cookie('oauth_state', ...) -> res.redirect(authUrl); GET /:provider/callback -> oauthCallbackHandler -> verifyStateCookie() -> oauthService.exchangeCodeForTokens() -> oauthService.getOrCreateOAuthUser() -> oauthService.createOAuthSession() -> res.redirect(frontendUrl)",
          "imports": [
            "oauthService from '../oauth.service.js'",
            "crypto (randomBytes for state generation)",
            "cookie-parser middleware",
            "Request, Response from 'express'"
          ],
          "typesInScope": [
            "OAuthProvider: 'google' | 'github'",
            "OAuthState { state: string, provider: string, expiresAt: Date }",
            "OAuthTokenResponse { access_token: string, token_type: string, scope: string }",
            "OAuthUserProfile { providerId: string, email: string, name: string, avatarUrl: string }"
          ],
          "testMock": [
            "vi.mock('../oauth.service.js', () => ({ oauthService: { getAuthorizationUrl: vi.fn(), exchangeCodeForTokens: vi.fn(), getOrCreateOAuthUser: vi.fn(), createOAuthSession: vi.fn() } }))",
            "Mock res.cookie/res.redirect/res.status/res.json on Express Response"
          ],
          "dangerZones": [
            "CSRF state cookie 必须设置 SameSite=Lax, HttpOnly, Secure（生产环境）",
            "state 参数过期时间控制（建议 10 分钟）",
            "callback 路由必须验证 state 匹配，否则攻击者可伪造 OAuth 回调",
            "redirect URL 白名单校验（防止 open redirect 漏洞）"
          ],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/oauth.service.test.ts — OAuth service 层已测试 getAuthorizationUrl/getOrCreateOAuthUser/createOAuthSession"
        },
        "codePatterns": [
          "state generation: crypto.randomBytes(32).toString('hex')",
          "cookie set: res.cookie('oauth_state', state, { maxAge: 600000, httpOnly: true, sameSite: 'lax' })",
          "redirect after auth: res.redirect(302, FRONTEND_CALLBACK_URL + '?token=' + jwtToken)"
        ],
        "gotchas": [
          "GitHub OAuth 用 POST 请求 access_token endpoint，Google 用 POST + form-urlencoded",
          "callback 中 state cookie 验证后应立即清除（防止重放）",
          "测试中 mock cookie 需同时处理 req.cookies 读取和 res.cookie 写入"
        ],
        "modelTier": "fast"
      },
      {
        "id": "acg-middleware-remaining",
        "implementationNotes": "middleware/auth.ts（位于 apps/api/src/middleware/auth.ts，非 modules/auth/middleware/ 下）中 checkOwnership/requireNotGuest/workspaceAuth 遵循 Express middleware 签名 (req, res, next)。checkOwnership(model, paramKey) 验证资源所有权（通过 prisma 查询 model 表确认 resource[paramKey] 对应的 ownerId 与 req.user.id 匹配）；requireNotGuest 检查 req.user.role !== 'guest'；workspaceAuth 验证 req.user.workspaceId 与目标 workspace 一致。generateAnonymousId(ip, userAgent) 基于 IP+UA+日期窗口 sha256 生成 anon_ 前缀标识符。测试复用 middleware-invocation.test.ts 的 mock 模式（mock verifyToken + prisma session）。",
        "architectureContext": {
          "functions": [
            "checkOwnership(model: string, paramKey: string = 'id'): (req: Request, res: Response, next: NextFunction) => Promise<void>",
            "requireNotGuest(req: Request, res: Response, next: NextFunction): void",
            "workspaceAuth(): (req: Request, res: Response, next: NextFunction) => Promise<void>",
            "generateAnonymousId(ip: string, userAgent: string): string (返回 anon_{sha256_16hex} 格式)"
          ],
          "callChain": "Express middleware chain: requireAuth -> checkOwnership('User', 'id') -> controller; 或 requireAuth -> requireNotGuest -> workspaceAuth() -> controller",
          "imports": [
            "verifyToken from '../modules/auth/service.js'",
            "prisma from '@dommaker/studio-prisma' (for session/resource lookup)",
            "logger from '../utils/logger.js'",
            "Request, Response, NextFunction from 'express'",
            "crypto from 'crypto' (for generateAnonymousId)"
          ],
          "typesInScope": [
            "AuthenticatedRequest extends Request { user: { id: string, role: string, workspaceId: string } }",
            "NextFunction: (err?: Error) => void"
          ],
          "testMock": [
            "vi.mock('../modules/auth/service.js', () => ({ verifyToken: vi.fn().mockResolvedValue({ userId: 'user-1', role: 'admin', workspaceId: 'ws-1' }) }))",
            "Mock req/res/next Express 三元组 (req = { params: {}, user: {} }, res = { status: vi.fn().mockReturnThis(), json: vi.fn() }, next = vi.fn())"
          ],
          "dangerZones": [
            "checkOwnership 若 resourceId 对应的资源不存在应返回 404 而非 403",
            "requireNotGuest 应与 requireAuth 组合使用，单独使用 req.user 可能为 undefined",
            "workspaceAuth 在跨 workspace 访问场景下需考虑 admin 角色的特权绕过"
          ],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts — requireAuth/optionalAuth/requireRole 已有工厂函数测试模式可复用。middleware 源文件位于 apps/api/src/middleware/auth.ts（非 modules/auth/middleware/），测试导入路径需用 ../../../middleware/auth.js。"
        },
        "codePatterns": [
          "Middleware factory: export const checkOwnership = (model, paramKey = 'id') => async (req, res, next) => { ... }",
          "Error response: res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' })",
          "generateAnonymousId: crypto.createHash('sha256').update(`${ip}|${userAgent}|${dateWindow}`).digest('hex').substring(0, 16) -> 'anon_' + hash"
        ],
        "gotchas": [
          "checkOwnership 工厂函数返回 async middleware，需在测试中 await 调用",
          "workspaceAuth 的 workspaceId 可能来自 req.params / req.body / req.user，需确认提取逻辑",
          "generateAnonymousId 需要 ip 和 userAgent 两个参数（非无参调用），基于日期窗口保证同一天同用户 ID 相同"
        ],
        "modelTier": "fast"
      },
      {
        "id": "acg-service-edge",
        "implementationNotes": "service.ts 的 getOrCreateSession 处理并发登录和设备管理；cleanupExpiredSessions 是定时任务调用的批量清理函数；verifyPassword 需兼容旧 PBKDF2 格式（格式标识前缀不同）；hashPassword 输出 bcrypt $2b$ 格式。测试复用 service.test.ts 的完整 mock 基础设施（prisma + jsonwebtoken + studio-shared + logger）。",
        "architectureContext": {
          "functions": [
            "getOrCreateSession(input: SessionInput): Promise<AuthResult>",
            "cleanupExpiredSessions(): Promise<number>",
            "verifyPassword(plaintext: string, hash: string): { valid: boolean; needsRehash: boolean }",
            "hashPassword(plaintext: string): string"
          ],
          "callChain": "getOrCreateSession: prisma.session.findFirst({ where: { userId, deviceInfo } }) -> if not found: prisma.session.create({ data: { userId, deviceInfo, token, expiresAt } }) -> return session; cleanupExpiredSessions: prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }); verifyPassword: 检测 hash 前缀 -> bcrypt (starts with $2b$) or PBKDF2 (starts with $pbkdf2$ or contains ':') -> 如果需要 rehash 则标记; hashPassword: bcrypt.hashSync(plaintext, 12)",
          "imports": [
            "prisma from '@dommaker/studio-prisma'",
            "bcrypt from 'bcrypt'",
            "crypto from 'crypto' (PBKDF2 path)",
            "jsonwebtoken from 'jsonwebtoken'",
            "logger from '@dommaker/studio-shared'",
            "JWT_SECRET from env"
          ],
          "typesInScope": [
            "Session { id: string, userId: string, token: string, deviceInfo: string, expiresAt: Date, createdAt: Date }",
            "User { id: string, email: string, passwordHash: string, role: string, workspaceId: string }",
            "JwtPayload { userId: string, sessionId: string, iat: number, exp: number }"
          ],
          "testMock": [
            "vi.mock('@dommaker/studio-prisma', () => ({ prisma: { user: { ... }, session: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() }, refreshToken: { ... } } }))",
            "vi.mock('@dommaker/studio-shared', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))",
            "vi.mock('jsonwebtoken', () => ({ default: { sign: vi.fn().mockReturnValue('mock-jwt-token'), verify: vi.fn() }, sign: vi.fn().mockReturnValue('mock-jwt-token'), verify: vi.fn() }))",
            "vi.mock('bcrypt', () => ({ default: { hashSync: vi.fn().mockReturnValue('$2b$10$hashedpassword'), compareSync: vi.fn() }, hashSync: vi.fn().mockReturnValue('$2b$10$hashedpassword'), compareSync: vi.fn() }))"
          ],
          "dangerZones": [
            "PBKDF2 旧格式兼容路径 — 若 detectHashFormat 逻辑错误，旧用户无法登录",
            "cleanupExpiredSessions 批量删除可能影响大量记录，需确认 prisma.deleteMany 的事务行为",
            "hashPassword 的 salt rounds 值影响安全性与性能平衡（当前值 12）",
            "getOrCreateSession 在并发登录时可能创建重复 session（需 unique constraint 防护）"
          ],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/service.test.ts — 已有完整的 prisma + jwt + bcrypt mock 基础设施"
        },
        "codePatterns": [
          "Password verify dispatch: hash.startsWith('$2b$') ? bcrypt.compareSync : PBKDF2 salt:hash split",
          "Session create: { userId, token: jwt.sign({ userId, sessionId }, JWT_SECRET, { expiresIn }), deviceInfo, expiresAt: addDays(new Date(), 7) }",
          "Cleanup: prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })"
        ],
        "gotchas": [
          "bcrypt.compareSync 返回 boolean，PBKDF2 verify 需自行实现 timingSafeEqual 防时序攻击",
          "getOrCreateSession 应使用 prisma 的 upsert 或事务来避免 race condition",
          "cleanupExpiredSessions 返回 number（deleted count），非 { deletedCount: number } 对象"
        ],
        "modelTier": "fast"
      },
      {
        "id": "acg-oauth-exchange",
        "implementationNotes": "exchangeCodeForTokens 是 OAuth2.0 授权码流程核心函数：使用 fetch() 向 Google token endpoint (https://oauth2.googleapis.com/token) 或 GitHub token endpoint (https://github.com/login/oauth/access_token) 交换 access_token。当前仅测试了 unsupported provider 的 throw 路径，需补充 mock fetch 测试 Google/GitHub 实际 HTTP 请求/响应。",
        "architectureContext": {
          "functions": [
            "exchangeCodeForTokens(provider: OAuthProvider, code: string, redirectUri: string): Promise<OAuthTokenResponse>",
            "getGoogleUserProfile(accessToken: string): Promise<OAuthUserProfile>",
            "getGitHubUserProfile(accessToken: string): Promise<OAuthUserProfile>"
          ],
          "callChain": "exchangeCodeForTokens -> switch(provider) -> Google: POST https://oauth2.googleapis.com/token { code, client_id, client_secret, redirect_uri, grant_type: 'authorization_code' } -> parse response { access_token, id_token } -> getGoogleUserProfile(accessToken); GitHub: POST https://github.com/login/oauth/access_token { code, client_id, client_secret } + Accept: application/json -> parse response -> getGitHubUserProfile(accessToken)",
          "imports": [
            "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET from env",
            "global fetch (Node 18+)",
            "logger from '@dommaker/studio-shared'"
          ],
          "typesInScope": [
            "OAuthProvider: 'google' | 'github'",
            "OAuthTokenResponse { access_token: string, token_type?: string, scope?: string, id_token?: string }",
            "OAuthUserProfile { providerId: string, email: string, name: string, avatarUrl?: string }"
          ],
          "testMock": [
            "vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ access_token: 'mock-access-token' }) } as Response)",
            "Vary mock per provider — Google returns id_token, GitHub returns access_token directly"
          ],
          "dangerZones": [
            "Google OAuth 返回 id_token (JWT) 需要解码验证，GitHub 直接返回 access_token",
            "client_secret 在请求体中传递，日志输出必须脱敏",
            "fetch 超时处理（建议 AbortController + 10s timeout）",
            "GitHub token endpoint 要求 Accept: application/json header，否则返回 URL-encoded"
          ],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/oauth.service.test.ts — 已有 unsupported provider throw 路径测试"
        },
        "codePatterns": [
          "Google token exchange: fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id, client_secret, redirect_uri, grant_type: 'authorization_code' }) })",
          "GitHub token exchange: fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ code, client_id, client_secret }) })",
          "User profile fetch: fetch(providerApiUrl, { headers: { Authorization: 'Bearer ' + accessToken } })"
        ],
        "gotchas": [
          "Node 18+ 原生 fetch 在测试中可用 vi.spyOn(global, 'fetch') mock，无需额外依赖",
          "Google 的 id_token 包含用户信息（JWT），可直接解码获取 email/name，无需额外 API 调用",
          "GitHub 获取用户信息需额外请求 GET https://api.github.com/user，获取 email 需 GET https://api.github.com/user/emails",
          "测试 fetch mock 需分别处理 token exchange 和 user profile 两次 HTTP 调用"
        ],
        "modelTier": "fast"
      }
    ]
  },
  "task": {
    "acGroups": [
      {
        "id": "acg-auth-routes",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/routes.test.ts",
            "content": "import { describe, it, expect, vi, beforeEach } from 'vitest';\nimport { authService } from '../service.js';\nimport { AuditService } from '@dommaker/studio-audit';\n\n// Mock dependencies — 匹配 routes.ts 实际 import 路径\nvi.mock('../service.js', () => ({\n  authService: {\n    createGuestSession: vi.fn(),\n    register: vi.fn(),\n    login: vi.fn(),\n    logout: vi.fn(),\n    getCurrentUser: vi.fn(),\n    cleanupExpiredSessions: vi.fn(),\n    refreshToken: vi.fn(),\n    getOrCreateSession: vi.fn(),\n  },\n}));\n\nvi.mock('@dommaker/studio-audit', () => ({\n  AuditService: vi.fn().mockImplementation(() => ({ log: vi.fn() })),\n}));\n\nvi.mock('@dommaker/studio-shared', () => ({\n  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },\n}));\n\ndescribe('Auth Routes', () => {\n  beforeEach(() => {\n    vi.clearAllMocks();\n  });\n\n  describe('POST /guest-session', () => {\n    it('should create guest session and return 200 with session', async () => {\n      const mockResult = { sessionId: 'sess-1', token: 'jwt-token', expiresAt: new Date() };\n      vi.mocked(authService.getOrCreateSession).mockResolvedValue(mockResult);\n      // Test handler...\n    });\n\n    it('should return 500 on service failure', async () => {\n      vi.mocked(authService.getOrCreateSession).mockRejectedValue(new Error('DB error'));\n      // Test handler...\n    });\n  });\n\n  describe('POST /register', () => {\n    it('should register user and return 201 with user data', async () => { /* ... */ });\n    it('should call AuditService.log on successful registration', async () => { /* ... */ });\n    it('should return 409 on duplicate email', async () => { /* ... */ });\n  });\n\n  describe('POST /login', () => {\n    it('should login user and return 200 with token', async () => { /* ... */ });\n    it('should call AuditService.log on successful login', async () => { /* ... */ });\n    it('should return 401 on invalid credentials', async () => { /* ... */ });\n  });\n\n  describe('POST /logout', () => {\n    it('should logout user and return 200', async () => { /* ... */ });\n    it('should call AuditService.log on logout', async () => { /* ... */ });\n  });\n\n  describe('GET /me', () => {\n    it('should return 200 with current user', async () => { /* ... */ });\n    it('should return 401 if not authenticated', async () => { /* ... */ });\n  });\n\n  describe('POST /cleanup', () => {\n    it('should cleanup expired sessions and return deleted count', async () => {\n      vi.mocked(authService.cleanupExpiredSessions).mockResolvedValue(5);\n      // Test handler...\n    });\n  });\n\n  describe('POST /refresh', () => {\n    it('should refresh token and return new access token', async () => { /* ... */ });\n    it('should return 401 on invalid refresh token', async () => { /* ... */ });\n  });\n});\n"
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/routes.test.ts"
        ],
        "contractTestsSkipReason": ""
      },
      {
        "id": "acg-oauth-routes",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/oauth.routes.test.ts",
            "content": "import { describe, it, expect, vi, beforeEach } from 'vitest';\nimport { oauthService } from '../oauth.service.js';\n\nvi.mock('../oauth.service.js', () => ({\n  oauthService: {\n    getAuthorizationUrl: vi.fn(),\n    exchangeCodeForTokens: vi.fn(),\n    getOrCreateOAuthUser: vi.fn(),\n    createOAuthSession: vi.fn(),\n  },\n}));\n\nvi.mock('@dommaker/studio-shared', () => ({\n  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },\n}));\n\nfunction mockRes() {\n  return {\n    status: vi.fn().mockReturnThis(),\n    json: vi.fn().mockReturnThis(),\n    cookie: vi.fn().mockReturnThis(),\n    redirect: vi.fn().mockReturnThis(),\n  };\n}\n\ndescribe('OAuth Routes', () => {\n  beforeEach(() => {\n    vi.clearAllMocks();\n  });\n\n  describe('GET /:provider', () => {\n    it('should generate state, set cookie, and redirect to provider auth URL', async () => {\n      vi.mocked(oauthService.getAuthorizationUrl).mockReturnValue('https://accounts.google.com/o/oauth2/auth?...');\n      const res = mockRes();\n      // Test redirect handler...\n      expect(res.cookie).toHaveBeenCalledWith('oauth_state', expect.any(String), expect.objectContaining({ httpOnly: true }));\n      expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('accounts.google.com'));\n    });\n\n    it('should return 400 for unsupported provider', async () => { /* ... */ });\n  });\n\n  describe('GET /:provider/callback', () => {\n    it('should exchange code, create user, and redirect with token on success', async () => {\n      vi.mocked(oauthService.exchangeCodeForTokens).mockResolvedValue({ access_token: 'at-1' });\n      vi.mocked(oauthService.getOrCreateOAuthUser).mockResolvedValue({ id: 'user-1' });\n      vi.mocked(oauthService.createOAuthSession).mockResolvedValue({ token: 'jwt-token' });\n      // Test callback handler...\n    });\n\n    it('should return 403 when CSRF state mismatch', async () => {\n      // req.cookies.oauth_state !== req.query.state\n      // ...\n    });\n\n    it('should return 400 when state cookie is missing', async () => { /* ... */ });\n\n    it('should handle exchangeCodeForTokens failure gracefully', async () => {\n      vi.mocked(oauthService.exchangeCodeForTokens).mockRejectedValue(new Error('Token exchange failed'));\n      // Test error handling...\n    });\n  });\n});\n"
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/oauth.routes.test.ts"
        ],
        "contractTestsSkipReason": ""
      },
      {
        "id": "acg-middleware-remaining",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/middleware-auth.test.ts",
            "content": "import { describe, it, expect, vi, beforeEach } from 'vitest';\n// 源文件位于 apps/api/src/middleware/auth.ts，测试在 modules/auth/__tests__/ 下\n// 正确相对路径: ../../../middleware/auth.js\nimport { checkOwnership, requireNotGuest, workspaceAuth, generateAnonymousId } from '../../../middleware/auth.js';\n\nfunction mockReq(overrides = {}) {\n  return {\n    user: { id: 'user-1', role: 'admin', workspaceId: 'ws-1' },\n    params: {},\n    body: {},\n    ...overrides,\n  };\n}\n\nfunction mockRes() {\n  return {\n    status: vi.fn().mockReturnThis(),\n    json: vi.fn().mockReturnThis(),\n  };\n}\n\ndescribe('checkOwnership', () => {\n  it('should call next() when user owns resource', async () => {\n    // checkOwnership(model, paramKey) — 默认 paramKey = 'id'\n    const middleware = checkOwnership('User', 'id');\n    const req = mockReq({ params: { id: 'user-1' } });\n    const res = mockRes();\n    const next = vi.fn();\n    await middleware(req, res, next);\n    expect(next).toHaveBeenCalledWith();\n  });\n\n  it('should return 403 when user does not own resource', async () => {\n    const middleware = checkOwnership('User', 'id');\n    const req = mockReq({ params: { id: 'user-2' } });\n    const res = mockRes();\n    const next = vi.fn();\n    await middleware(req, res, next);\n    expect(res.status).toHaveBeenCalledWith(403);\n    expect(next).not.toHaveBeenCalled();\n  });\n\n  it('should return 401 when user is not authenticated', async () => { /* ... */ });\n});\n\ndescribe('requireNotGuest', () => {\n  it('should call next() for non-guest user', async () => { /* ... */ });\n  it('should return 403 for guest user (role=guest)', async () => { /* ... */ });\n  it('should return 401 when user is undefined', async () => { /* ... */ });\n});\n\ndescribe('workspaceAuth', () => {\n  it('should call next() when user belongs to workspace', async () => { /* ... */ });\n  it('should return 403 when user does not belong to workspace', async () => { /* ... */ });\n});\n\ndescribe('generateAnonymousId', () => {\n  // 实际签名: generateAnonymousId(ip: string, userAgent: string): string\n  // 返回格式: anon_{sha256_16hex}\n  it('should return a string starting with anon_ prefix', () => {\n    const id = generateAnonymousId('127.0.0.1', 'Mozilla/5.0 TestAgent');\n    expect(typeof id).toBe('string');\n    expect(id).toMatch(/^anon_[a-f0-9]{16}$/);\n  });\n\n  it('should generate same ID for same input on same day', () => {\n    const ip = '192.168.1.1';\n    const ua = 'TestAgent/1.0';\n    const id1 = generateAnonymousId(ip, ua);\n    const id2 = generateAnonymousId(ip, ua);\n    expect(id1).toBe(id2);\n  });\n\n  it('should generate different IDs for different IPs', () => {\n    const id1 = generateAnonymousId('10.0.0.1', 'TestAgent');\n    const id2 = generateAnonymousId('10.0.0.2', 'TestAgent');\n    expect(id1).not.toBe(id2);\n  });\n});\n"
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/middleware-auth.test.ts"
        ],
        "contractTestsSkipReason": ""
      },
      {
        "id": "acg-service-edge",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/service-edge.test.ts",
            "content": "import { describe, it, expect, vi, beforeEach } from 'vitest';\n\n// Reuse mock infrastructure from service.test.ts\nvi.mock('@dommaker/studio-prisma', () => ({\n  prisma: {\n    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },\n    session: {\n      findFirst: vi.fn(),\n      findUnique: vi.fn(),\n      create: vi.fn(),\n      update: vi.fn(),\n      deleteMany: vi.fn(),\n    },\n    refreshToken: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },\n  },\n}));\n\nvi.mock('@dommaker/studio-shared', () => ({\n  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },\n}));\n\nvi.mock('jsonwebtoken', () => ({\n  default: { sign: vi.fn().mockReturnValue('mock-jwt-token'), verify: vi.fn() },\n  sign: vi.fn().mockReturnValue('mock-jwt-token'),\n  verify: vi.fn(),\n}));\n\nvi.mock('bcrypt', () => ({\n  default: { hashSync: vi.fn().mockReturnValue('$2b$10$hashedpassword'), compareSync: vi.fn() },\n  hashSync: vi.fn().mockReturnValue('$2b$10$hashedpassword'),\n  compareSync: vi.fn(),\n}));\n\nimport { prisma } from '@dommaker/studio-prisma';\nimport bcrypt from 'bcrypt';\n\ndescribe('getOrCreateSession', () => {\n  it('should return existing session if found', async () => {\n    vi.mocked(prisma.session.findFirst).mockResolvedValue({\n      id: 'sess-1', userId: 'user-1', token: 'existing-jwt', deviceInfo: 'chrome',\n      expiresAt: new Date(), createdAt: new Date(),\n    });\n    // await getOrCreateSession({ guestId: 'user-1', ipAddress: '127.0.0.1', userAgent: 'chrome' })\n    expect(prisma.session.findFirst).toHaveBeenCalledWith({\n      where: { userId: 'user-1', deviceInfo: 'chrome' },\n    });\n  });\n\n  it('should create new session if not found', async () => {\n    vi.mocked(prisma.session.findFirst).mockResolvedValue(null);\n    vi.mocked(prisma.session.create).mockResolvedValue({\n      id: 'sess-new', userId: 'user-1', token: 'new-jwt', deviceInfo: 'chrome',\n      expiresAt: new Date(), createdAt: new Date(),\n    });\n    // await getOrCreateSession({ guestId: 'user-1', ipAddress: '127.0.0.1', userAgent: 'chrome' })\n    expect(prisma.session.create).toHaveBeenCalled();\n  });\n});\n\ndescribe('cleanupExpiredSessions', () => {\n  it('should delete all sessions with expiresAt < now and return deleted count', async () => {\n    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 3 });\n    // const result = await cleanupExpiredSessions()\n    // expect(result).toBe(3) — 返回 number 非 { deletedCount }\n  });\n\n  it('should return 0 when no expired sessions', async () => {\n    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 0 });\n    // const result = await cleanupExpiredSessions()\n    // expect(result).toBe(0)\n  });\n});\n\ndescribe('verifyPassword (PBKDF2 old format)', () => {\n  it('should verify PBKDF2 hash correctly', async () => {\n    // 旧格式: salt:hash (恰好一个冒号)\n    // verifyPassword 返回 { valid: boolean, needsRehash: boolean }\n    // const result = verifyPassword('plaintext', 'salt:hash')\n    // expect(result.valid).toBe(true)\n    // expect(result.needsRehash).toBe(true)\n  });\n\n  it('should return valid=false for incorrect PBKDF2 password', async () => {\n    // const result = verifyPassword('wrong', 'salt:hash')\n    // expect(result.valid).toBe(false)\n  });\n\n  it('should return valid=false when salt or hash part is empty', async () => {\n    // const result = verifyPassword('password', ':emptyhash')\n    // expect(result.valid).toBe(false)\n  });\n});\n\ndescribe('hashPassword', () => {\n  it('should return bcrypt hash starting with $2b$', async () => {\n    const hash = await (await import('../service.js')).hashPassword('plaintext');\n    expect(hash).toMatch(/^\\$2b\\$/);\n  });\n\n  it('should produce different hashes for same password (salt randomness)', async () => {\n    // Test hash uniqueness — bcrypt salt 内嵌确保每次不同\n  });\n});\n"
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/service-edge.test.ts"
        ],
        "contractTestsSkipReason": ""
      },
      {
        "id": "acg-oauth-exchange",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/oauth.service.test.ts",
            "content": "import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';\n\ndescribe('exchangeCodeForTokens', () => {\n  beforeEach(() => {\n    vi.stubGlobal('fetch', vi.fn());\n  });\n\n  afterEach(() => {\n    vi.unstubAllGlobals();\n  });\n\n  describe('Google provider', () => {\n    it('should exchange code for tokens via Google token endpoint', async () => {\n      vi.mocked(global.fetch).mockResolvedValueOnce({\n        ok: true,\n        json: async () => ({\n          access_token: 'google-access-token',\n          id_token: 'google-id-token',\n          token_type: 'Bearer',\n        }),\n      } as Response);\n\n      // const tokens = await exchangeCodeForTokens('google', 'auth-code', 'http://localhost/callback');\n      expect(global.fetch).toHaveBeenCalledWith(\n        'https://oauth2.googleapis.com/token',\n        expect.objectContaining({\n          method: 'POST',\n          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },\n        })\n      );\n      // expect(tokens.access_token).toBe('google-access-token');\n    });\n\n    it('should throw on Google token endpoint error response', async () => {\n      vi.mocked(global.fetch).mockResolvedValueOnce({\n        ok: false,\n        status: 400,\n        json: async () => ({ error: 'invalid_grant' }),\n      } as Response);\n\n      // await expect(exchangeCodeForTokens('google', 'bad-code', '...')).rejects.toThrow();\n    });\n  });\n\n  describe('GitHub provider', () => {\n    it('should exchange code for token via GitHub token endpoint', async () => {\n      vi.mocked(global.fetch).mockResolvedValueOnce({\n        ok: true,\n        json: async () => ({\n          access_token: 'github-access-token',\n          token_type: 'bearer',\n          scope: 'user:email',\n        }),\n      } as Response);\n\n      // const tokens = await exchangeCodeForTokens('github', 'auth-code', 'http://localhost/callback');\n      expect(global.fetch).toHaveBeenCalledWith(\n        'https://github.com/login/oauth/access_token',\n        expect.objectContaining({\n          method: 'POST',\n          headers: expect.objectContaining({ Accept: 'application/json' }),\n        })\n      );\n    });\n\n    it('should throw on GitHub token endpoint error', async () => {\n      vi.mocked(global.fetch).mockResolvedValueOnce({\n        ok: false,\n        status: 401,\n        json: async () => ({ error: 'bad_verification_code' }),\n      } as Response);\n\n      // await expect(exchangeCodeForTokens('github', 'bad-code', '...')).rejects.toThrow();\n    });\n  });\n\n  it('should throw for unsupported provider', async () => {\n    // await expect(exchangeCodeForTokens('facebook' as any, 'code', '...')).rejects.toThrow('Unsupported provider');\n  });\n\n  it('should handle network timeout gracefully', async () => {\n    vi.mocked(global.fetch).mockRejectedValueOnce(new Error('AbortError'));\n    // await expect(exchangeCodeForTokens('google', 'code', '...')).rejects.toThrow();\n  });\n});\n"
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/oauth.service.test.ts"
        ],
        "contractTestsSkipReason": ""
      }
    ]
  }
}
```
