<!-- GATE_REVISION_ATTEMPT 2 -->

```json
{
  "requirement": {
    "title": "JWT 用户认证系统 + OAuth2.0 第三方登录",
    "summary": "实现基于 JWT 的用户认证系统，包含：JWT token 签发/验证、bcrypt 密码哈希、用户注册/登录/登出、Guest session 与匿名访问、Refresh token 轮换刷新机制、OAuth2.0 Google/GitHub 第三方登录、认证中间件链（requireAuth/optionalAuth/requireRole/workspaceAuth）、速率限制防护（10/min 登录、20/min 刷新）。前端 axios interceptor 自动处理 401 → refresh → retry 流程。",
    "tier": "premium",
    "tierReason": "需求涉及 auth/jwt/oauth/security 关键词，按 preClassifyTier 规则判为 premium tier。包含多模型（User/Session/RefreshToken/OAuthAccount）、多中间件链、OAuth2 原生实现、refresh token 轮换等安全敏感操作，需要更重的分析管线。",
    "acGroups": [
      {
        "id": "ac-jwt-core",
        "acs": [
          "签发 JWT token 时 payload 必须包含 { sid: sessionId, uid?: userId }，过期时间 7 天",
          "验证 JWT token 返回 { sessionId, userId } 或 null，不抛异常"
        ],
        "files": [
          "apps/api/src/modules/auth/service.ts"
        ],
        "dependencies": []
      },
      {
        "id": "ac-password-config",
        "acs": [
          "密码哈希使用 bcryptjs，支持旧 PBKDF2 格式兼容验证与静默升级",
          "JWT_SECRET 生产环境从环境变量读取，缺失则启动阻断"
        ],
        "files": [
          "apps/api/src/modules/auth/service.ts"
        ],
        "dependencies": []
      },
      {
        "id": "ac-session",
        "acs": [
          "创建 Guest session：接受 { guestId?, ipAddress?, userAgent? }，生成 JWT token 并持久化 Session 记录",
          "login 时自动清理该用户所有有效 Guest session（session.findMany + deleteMany）",
          "getCurrentUser 通过 sessionId 查找当前用户与会话状态"
        ],
        "files": [
          "apps/api/src/modules/auth/service.ts"
        ],
        "dependencies": [
          "ac-jwt-core"
        ]
      },
      {
        "id": "ac-session-utils",
        "acs": [
          "getOrCreateSession：按 IP+UA+guestId 查找已有 session 复用，否则创建新 session",
          "cleanupExpiredSessions 定时清理过期 session，返回清理数量"
        ],
        "files": [
          "apps/api/src/modules/auth/service.ts",
          "apps/api/src/modules/auth/routes.ts"
        ],
        "dependencies": [
          "ac-jwt-core"
        ]
      },
      {
        "id": "ac-auth-endpoints",
        "acs": [
          "POST /api/v1/auth/register：接受 { email, password, name? }，email 唯一校验，bcrypt 哈希存储，role 默认 'User'",
          "POST /api/v1/auth/login：接受 { email, password }，验证密码，返回 token + refreshToken + user + session",
          "POST /api/v1/auth/logout：需 requireAuth，删除当前 session 及关联 refresh token",
          "GET /api/v1/auth/me：需 optionalAuth，返回当前 user + session 或 null",
          "POST /api/v1/auth/guest-session：创建匿名 guest session，返回 token + session"
        ],
        "files": [
          "apps/api/src/modules/auth/service.ts",
          "apps/api/src/modules/auth/routes.ts",
          "apps/api/src/route-registry.ts"
        ],
        "dependencies": [
          "ac-jwt-core",
          "ac-session",
          "ac-rate-limit"
        ]
      },
      {
        "id": "ac-refresh-token",
        "acs": [
          "generateRefreshToken 生成 30 天有效期的 refresh token 并持久化到 RefreshToken 表",
          "exchangeRefreshToken 同时执行：吊销旧 token → 创建新 session → 生成新 refresh token（rotation）",
          "revokeRefreshToken 吊销指定 refresh token（设置 revokedAt）"
        ],
        "files": [
          "apps/api/src/modules/auth/service.ts"
        ],
        "dependencies": [
          "ac-jwt-core",
          "ac-session"
        ]
      },
      {
        "id": "ac-refresh-client",
        "acs": [
          "前端 axios interceptor：401 响应触发 refresh，并发请求排队避免重复刷新",
          "refresh 端点使用独立速率限制 20/min/IP"
        ],
        "files": [
          "apps/api/src/modules/auth/routes.ts",
          "apps/web/src/api/index.ts"
        ],
        "dependencies": [
          "ac-refresh-token"
        ]
      },
      {
        "id": "ac-oauth",
        "acs": [
          "GET /api/v1/auth/:provider(google|github)：生成 OAuth 授权 URL，httpOnly cookie 存 state 防 CSRF",
          "GET /api/v1/auth/callback/:provider(google|github)：验证 state cookie → exchange code → 获取 profile → 查找或创建用户 → 创建 session",
          "getOrCreateOAuthUser：按 provider+providerAccountId 查找已有 OAuth 账号，不存在则：email 匹配现有用户 → 链接，否则创建新用户 + OAuth 账号",
          "createOAuthSession：生成 JWT token + refresh token，token 通过 URL fragment (#) 传回前端避免 Referer 泄漏",
          "OAuth 原生实现，不依赖 passport.js"
        ],
        "files": [
          "apps/api/src/modules/auth/oauth.service.ts",
          "apps/api/src/modules/auth/oauth.routes.ts",
          "apps/api/src/route-registry.ts"
        ],
        "dependencies": [
          "ac-jwt-core",
          "ac-session",
          "ac-refresh-token"
        ]
      },
      {
        "id": "ac-middleware-core",
        "acs": [
          "requireAuth：验证 JWT → 查找 session → 注入 req.user/req.session，失败返回 401",
          "optionalAuth：有 token 则验证注入，无 token 则 generateAnonymousId（IP+UA+date 哈希）注入 req.anonymousId",
          "requireRole(...roles)：在 requireAuth 后检查 req.user.role 是否在允许列表，不在返回 403"
        ],
        "files": [
          "apps/api/src/middleware/auth.ts"
        ],
        "dependencies": [
          "ac-jwt-core"
        ]
      },
      {
        "id": "ac-middleware-ext",
        "acs": [
          "requireNotGuest：拒绝 role='Guest' 的用户访问敏感端点",
          "checkOwnership(model, paramKey)：检查请求者是否拥有目标资源的访问权",
          "workspaceAuth：验证 workspace token 并注入 req.workspace"
        ],
        "files": [
          "apps/api/src/middleware/auth.ts"
        ],
        "dependencies": [
          "ac-middleware-core"
        ]
      },
      {
        "id": "ac-rate-limit",
        "acs": [
          "authRateLimit：登录/注册端点 10 次请求/分钟/IP，防暴力破解",
          "refreshRateLimit：refresh 端点 20 次请求/分钟/IP",
          "速率限制基于 express-rate-limit 中间件"
        ],
        "files": [
          "apps/api/src/middleware/rate-limit.ts",
          "apps/api/src/modules/auth/routes.ts"
        ],
        "dependencies": []
      }
    ],
    "constraints": [
      "JWT payload 结构 { sid, uid } 不可变更 — 下游 middleware/auth.ts 依赖 payload.sessionId 查 session",
      "AuthResult 必须包含 refreshToken 字段 — 前端 authStore.ts 依赖此字段进行 401 自动刷新",
      "JWT_EXPIRES_IN_SECONDS = 7天 与 RefreshToken 30天 过期策略需协调，不可单独修改",
      "generateAnonymousId 哈希算法不可变更 — SEC-009 匿名审计标识依赖 IP+UA+date 一致性",
      "OAuth state cookie CSRF 检查不可移除 — 防止攻击者构造回调 URL 绑定攻击者账户到受害者邮箱",
      "authRateLimit 10/min 阈值不可随意放松 — 需安全评审",
      "禁止硬编码凭证 — JWT_SECRET、OAuth client_secret 必须从环境变量读取"
    ],
    "tags": [
      "auth",
      "jwt",
      "oauth",
      "security",
      "session",
      "refresh-token"
    ]
  },
  "design": {
    "acGroups": [
      {
        "id": "ac-jwt-core",
        "implementationNotes": "JWT 签发使用 jsonwebtoken 库，payload 固定 { sid: sessionId, uid?: userId }。验证函数 try/catch 包裹 jwt.verify，不抛异常，统一返回 null 或解析后的 payload。",
        "architectureContext": {
          "functions": [
            "generateToken(sessionId: string, userId?: string): string @ service.ts:75-77",
            "verifyToken(token: string): { sessionId: string; userId?: string } | null @ service.ts:82-92"
          ],
          "callChain": "auth/routes.ts:requireAuth → middleware/auth.ts:requireAuth → auth/service.ts:verifyToken → jsonwebtoken.verify → prisma.session.findUnique",
          "imports": [
            "import jwt from 'jsonwebtoken'",
            "import { prisma } from '@dommaker/studio-prisma'"
          ],
          "typesInScope": [
            "AuthResult — { user?: User; session: Session; token: string; isNewUser?: boolean; refreshToken?: string }"
          ],
          "testMock": [
            "mock jsonwebtoken.sign/verify 控制 token 行为"
          ],
          "dangerZones": [
            "service.ts:L13 — JWT_SECRET: 生产环境未设则直接 throw Error (启动阻断), dev 有默认值但明文硬编码不安全"
          ],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/service.test.ts:434 行, apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts:164 行"
        },
        "codePatterns": [],
        "gotchas": [
          "不可删除 JWT payload 字段 { sid, uid } — 下游 consumer: middleware/auth.ts L113-126 用 payload.sessionId 查 session, 前端无解析 (透传)",
          "不可修改 JWT_EXPIRES_IN_SECONDS = 7*24*60*60 不告知 — 前端无 JWT payload 解析 (所有判断靠 /auth/me 端点), RefreshToken 过期 30 天, 两者需协调"
        ],
        "modelTier": "standard"
      },
      {
        "id": "ac-password-config",
        "implementationNotes": "密码哈希使用 bcryptjs (cost=12)。同时兼容旧 PBKDF2 salt:hash 格式——旧格式验证通过后标记 needsRehash，在 login 流程中自动升级为 bcrypt 存储。JWT_SECRET 生产环境必须设环境变量，dev 模式有默认值但明文硬编码仅用于开发。",
        "architectureContext": {
          "functions": [
            "hashPassword(password: string): string @ service.ts:47-49",
            "verifyPassword(password: string, storedHash: string): { valid: boolean; needsRehash: boolean } @ service.ts:56-70"
          ],
          "callChain": "login/register → hashPassword/verifyPassword → bcrypt.compareSync / crypto.pbkdf2Sync",
          "imports": [
            "import bcrypt from 'bcryptjs'",
            "import * as crypto from 'crypto'"
          ],
          "typesInScope": [
            "LoginInput — { email: string; password: string }",
            "RegisterInput — { email: string; password: string; name?: string }"
          ],
          "testMock": [],
          "dangerZones": [
            "service.ts:L13 — JWT_SECRET: 生产环境未设则直接 throw Error (启动阻断)",
            "service.ts:L56-L70 — verifyPassword: PBKDF2 旧格式兼容逻辑, 删除前需确认 DB 中无旧格式 hash 残留"
          ],
          "verifiedAt": "内部辅助函数，通过 login/register 集成测试间接验证"
        },
        "codePatterns": [
          "密码旧格式兼容与静默升级: verifyPassword 同时支持 bcrypt 和旧 PBKDF2 salt:hash 格式, 旧格式验证通过后触发 needsRehash 标记 → login 流程中自动升级"
        ],
        "gotchas": [],
        "modelTier": "standard"
      },
      {
        "id": "ac-session",
        "implementationNotes": "Guest session 使用 UUID 生成 guestId，token 为 JWT。登录时自动清理所有该用户有效 guest session（session.findMany + deleteMany）。getCurrentUser 通过 sessionId 查 session 并 include User，过期 session 返回 null。",
        "architectureContext": {
          "functions": [
            "createGuestSession(input: SessionInput): Promise<AuthResult> @ service.ts:97-122",
            "login(input: LoginInput): Promise<AuthResult> @ service.ts:151-217",
            "getCurrentUser(sessionId: string): Promise<{ user: User | null; session: Session | null }> @ service.ts:292-306"
          ],
          "callChain": "route-registry.ts:buildRouteTable → auth/routes.ts:default → auth/service.ts (createGuestSession/login/register/getCurrentUser/logout)",
          "imports": [
            "import { prisma } from '@dommaker/studio-prisma'",
            "import jwt from 'jsonwebtoken'"
          ],
          "typesInScope": [
            "SessionInput — { guestId?: string; ipAddress?: string; userAgent?: string }",
            "Session (Prisma) — id, userId?, token (unique JWT), guestId?, ipAddress?, userAgent?, expiresAt",
            "User (Prisma) — id, email, passwordHash?, name?, avatar?, role (Guest|User|Admin), sessions[], refreshTokens[], oauthAccounts[]"
          ],
          "testMock": [
            "mock prisma.session.create/update 控制 session 创建与 token 更新",
            "mock prisma.session.findMany 模拟已有 guest session 列表",
            "mock prisma.session.deleteMany 验证 guest session 清理"
          ],
          "dangerZones": [],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/service.test.ts:434 行"
        },
        "codePatterns": [
          "Guest → User 会话迁移: 用户 login 后自动清理其所有有效 guest session (session.findMany + deleteMany), 后续请求用新 user session"
        ],
        "gotchas": [],
        "modelTier": "standard"
      },
      {
        "id": "ac-session-utils",
        "implementationNotes": "getOrCreateSession 按 guestId 查找已有 session，有效则复用否则调用 createGuestSession 新建。cleanupExpiredSessions 扫描 expiresAt < now() 批量删除，返回删除数量，由 Admin-only POST /auth/cleanup 端点调用。",
        "architectureContext": {
          "functions": [
            "getOrCreateSession(input: SessionInput): Promise<AuthResult> @ service.ts:127-146",
            "cleanupExpiredSessions(): Promise<number> @ service.ts:311-319"
          ],
          "callChain": "routes.ts POST /guest-session → getOrCreateSession; POST /cleanup (Admin) → cleanupExpiredSessions",
          "imports": [
            "import { prisma } from '@dommaker/studio-prisma'"
          ],
          "typesInScope": [
            "SessionInput — { guestId?: string; ipAddress?: string; userAgent?: string }"
          ],
          "testMock": [],
          "dangerZones": [],
          "verifiedAt": "getOrCreateSession 通过 guest-session 路由测试间接覆盖; cleanupExpiredSessions 为 Admin 端点，无独立单元测试"
        },
        "codePatterns": [],
        "gotchas": [],
        "modelTier": "standard"
      },
      {
        "id": "ac-auth-endpoints",
        "implementationNotes": "5 个端点挂在 /api/v1/auth 路径下（route-registry.ts L164-165），login/register 端点套用 authRateLimit(10/min) 中间件。register 流程：email 查重 → bcrypt 哈希 → 创建 user(role='User') → 创建 session → 返回 AuthResult。login 流程：email 查用户 → verifyPassword → 清理 guest sessions → 创建 session + refresh token → 返回 AuthResult。logout 需要 requireAuth 中间件。me 端点使用 optionalAuth（无 token 返回 null）。guest-session 端点公开访问。",
        "architectureContext": {
          "functions": [
            "login(input: LoginInput): Promise<AuthResult> @ service.ts:151-217",
            "register(input: RegisterInput): Promise<AuthResult> @ service.ts:222-268",
            "logout(sessionId: string, userId?: string): Promise<void> @ service.ts:275-287",
            "getCurrentUser(sessionId: string): Promise<{ user: User | null; session: Session | null }> @ service.ts:292-306",
            "getOrCreateSession(input: SessionInput): Promise<AuthResult> @ service.ts:127-146"
          ],
          "callChain": "route-registry.ts:buildRouteTable → auth/routes.ts:default → auth/service.ts + middleware (authRateLimit/requireAuth/optionalAuth/requireRole)",
          "imports": [
            "import { requireAuth, getAuthInfo, optionalAuth, requireRole } from '../../middleware/auth.js'",
            "import { authRateLimit, refreshRateLimit } from '../../middleware/rate-limit.js'",
            "import { AuditService } from '@dommaker/studio-audit'"
          ],
          "typesInScope": [
            "LoginInput — { email: string; password: string }",
            "RegisterInput — { email: string; password: string; name?: string }",
            "SessionInput — { guestId?: string; ipAddress?: string; userAgent?: string }",
            "AuthResult — { user?: User; session: Session; token: string; isNewUser?: boolean; refreshToken?: string }"
          ],
          "testMock": [
            "mock prisma.user.findUnique 模拟 email 查重",
            "mock prisma.user.create 验证注册流程",
            "mock AuthService.login/register/logout 单元测试覆盖"
          ],
          "dangerZones": [
            "schema.prisma:L423 — User.role 默认值 'Guest', 若新注册用户未显式设 role 则自动 Guest (但 register 中 hardcode 了 'User')",
            "route-registry.ts:L164-165 — authRoutes + oauthRoutes 都挂载在 /api/v1/auth 下, 新增端点注意不要路径冲突"
          ],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/service.test.ts:434 行, apps/api/tests/auth-flow.e2e.test.ts:147 行"
        },
        "codePatterns": [],
        "gotchas": [
          "不可删除 AuthResult 的 refreshToken 字段 — 下游: frontend authStore.ts L134/158 存 refreshToken, web/api/index.ts L98-108 用 refreshToken 做 401 自动刷新"
        ],
        "modelTier": "standard"
      },
      {
        "id": "ac-refresh-token",
        "implementationNotes": "Refresh token 30 天有效期，持久化在 RefreshToken 表。exchangeRefreshToken 为 rotation 模式：吊销旧 token(set revokedAt) → 创建新 session → 生成新 access token + 新 refresh token。注意：此操作非事务包裹，并发场景可能重复消费。",
        "architectureContext": {
          "functions": [
            "generateRefreshToken(userId: string): Promise<string> @ service.ts:326-336",
            "exchangeRefreshToken(refreshToken: string): Promise<{ accessToken; refreshToken; userId } | null> @ service.ts:341-372",
            "revokeRefreshToken(refreshToken: string): Promise<boolean> @ service.ts:377-392"
          ],
          "callChain": "web/api/index.ts:api.interceptors.response (401 catch) → refreshToken() → POST /auth/refresh → service.ts:exchangeRefreshToken",
          "imports": [
            "import { generateRefreshToken, JWT_SECRET } from './service.js'",
            "import { prisma } from '@dommaker/studio-prisma'"
          ],
          "typesInScope": [
            "RefreshToken (Prisma) — id, token (unique), userId, expiresAt, revokedAt?"
          ],
          "testMock": [
            "mock prisma.refreshToken.findUnique/create/update 验证 rotation 逻辑"
          ],
          "dangerZones": [
            "service.ts:L341-L372 — exchangeRefreshToken: 同时吊销旧 token + 创建新 session + 新 refresh token, 非事务包裹 (并发场景可能重复消费)"
          ],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/service.test.ts:434 行"
        },
        "codePatterns": [
          "Refresh Token 轮换 (Rotation): exchangeRefreshToken 吊销旧 token → 创建新 access token + 新 refresh token"
        ],
        "gotchas": [],
        "modelTier": "premium"
      },
      {
        "id": "ac-refresh-client",
        "implementationNotes": "前端 axios interceptor 侦测 401 → 用独立 axios 实例发 refresh 请求 → 更新 localStorage → retry 原请求。并发请求排队：isRefreshing 标志 + failedQueue 队列。refresh 端点使用 refreshRateLimit(20/min/IP) 中间件。",
        "architectureContext": {
          "functions": [
            "api.interceptors.response (401 catch) @ web/api/index.ts:70-130",
            "refreshToken(refreshTokenValue) @ web/api/index.ts:64-67"
          ],
          "callChain": "axios response interceptor (401) → getStoredAuth() → refreshToken() → POST /auth/refresh → update localStorage → flushQueue + retry",
          "imports": [
            "import axios from 'axios'"
          ],
          "typesInScope": [],
          "testMock": [],
          "dangerZones": [
            "web/api/index.ts:L49-L50 — isRefreshing/queue 为模块级变量, 多 tab 场景不共享状态"
          ],
          "verifiedAt": "前端代码，无独立单元测试；刷新端点路由测试在 auth-flow.e2e.test.ts"
        },
        "codePatterns": [
          "401 → refresh → retry: axios response interceptor 侦测 401 → 独立 axios 实例避免递归 → 并发请求排队 (failedQueue)"
        ],
        "gotchas": [],
        "modelTier": "premium"
      },
      {
        "id": "ac-oauth",
        "implementationNotes": "OAuth2 原生实现，不依赖 passport.js。用 native fetch 做 code exchange。CSRF 防护：httpOnly cookie 存随机 state，回调时先验证 state 再 clear cookie。token 通过 URL fragment (#) 传回前端避免 Referer 泄漏。getOrCreateOAuthUser 策略：① 按 provider+providerAccountId 查 OAuthAccount → ② email 匹配现有 User → 链接 → ③ 创建新 User + OAuthAccount。",
        "architectureContext": {
          "functions": [
            "getAuthorizationUrl(provider: OAuthProvider, state: string): string @ oauth.service.ts:31-63",
            "exchangeCodeForTokens(provider: OAuthProvider, code: string): Promise<{ profile; tokens }> @ oauth.service.ts:68-80",
            "getOrCreateOAuthUser(provider: OAuthProvider, profile: OAuthProfile, tokens: OAuthTokens): Promise<{ user }> @ oauth.service.ts:232-311",
            "createOAuthSession(userId: string, req): Promise<{ token; refreshToken; session }> @ oauth.service.ts:316-353"
          ],
          "callChain": "route-registry.ts:buildRouteTable → auth/oauth.routes.ts:default → auth/oauth.service.ts (getAuthorizationUrl/exchangeCodeForTokens/getOrCreateOAuthUser/createOAuthSession)",
          "imports": [
            "import { prisma } from '@dommaker/studio-prisma'",
            "import { generateRefreshToken, JWT_SECRET } from './service.js'"
          ],
          "typesInScope": [
            "OAuthProvider — 'google' | 'github'",
            "OAuthProfile — { provider: OAuthProvider; providerAccountId: string; email: string; name: string | null; avatar: string | null }",
            "OAuthTokens — { accessToken: string; refreshToken: string | null; expiresAt: Date | null }",
            "OAuthAccount (Prisma) — id, userId, provider, providerAccountId, accessToken?, refreshToken?, expiresAt?, profile? @@unique([provider, providerAccountId])"
          ],
          "testMock": [
            "mock fetch 控制 Google/GitHub token endpoint 响应",
            "mock prisma.oAuthAccount.findUnique 模拟已有/新 OAuth 账号",
            "mock prisma.user.findUnique/create 验证用户查找/创建逻辑"
          ],
          "dangerZones": [
            "oauth.routes.ts:L57 — CSRF state 验证: cookie 被 clear 后才比较, 若 clearCookie 失败则比较永远为 true (宽松但非漏洞因 cookie 未清除会继续匹配)"
          ],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/oauth.service.test.ts:258 行"
        },
        "codePatterns": [
          "OAuth2 原生实现 (无 passport.js): 用 native fetch 做 code exchange, URL 拼 authorization url。CSRF 用 httpOnly cookie 存 state。token 通过 URL fragment (#) 传回前端避免 Referer 泄漏"
        ],
        "gotchas": [
          "不可删除 oauth.routes.ts 的 state cookie CSRF 检查 (L57) — 安全漏洞: 攻击者可构造回调 URL 绑定攻击者账户到受害者邮箱"
        ],
        "modelTier": "premium"
      },
      {
        "id": "ac-middleware-core",
        "implementationNotes": "中间件工厂模式：requireAuth()/optionalAuth()/requireRole() 均返回 (req, res, next) => void 闭包，在 route-registry 中用 middleware: [requireAuth()] 数组挂载。optionalAuth 无 token 时调用 generateAnonymousId(IP+UA+date 哈希) 生成匿名标识用于审计追踪。requireAuth 注入 req.user/req.session 到下游 handler。",
        "architectureContext": {
          "functions": [
            "requireAuth(): (req, res, next) => void @ middleware/auth.ts:146-206",
            "optionalAuth(): (req, res, next) => void @ middleware/auth.ts:97-138",
            "requireRole(...roles: string[]): (req, res, next) => void @ middleware/auth.ts:211-242"
          ],
          "callChain": "middleware/auth.ts:optionalAuth → auth/service.ts:verifyToken → prisma.session.findUnique (no token → generateAnonymousId 降级路径)",
          "imports": [
            "import { verifyToken } from '../modules/auth/service.js'",
            "import { User, Session, Workspace, WorkspaceToken } from '@prisma/client'"
          ],
          "typesInScope": [
            "AuthRequest (Express) — extends Request { user?: User | null; session?: Session | null; anonymousId?: string; workspace?: Workspace | null; workspaceToken?: WorkspaceToken | null }"
          ],
          "testMock": [
            "mock verifyToken 返回 null 或 { sessionId, userId }",
            "mock prisma.session.findUnique 返回 session 或 null"
          ],
          "dangerZones": [
            "middleware/auth.ts:L41-L48 — getAuthInfo() 返回的 sessionId 为空字符串兜底, 下游消费方可能未判断空值"
          ],
          "verifiedAt": "apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts:164 行"
        },
        "codePatterns": [
          "中间件工厂模式: requireAuth()/optionalAuth()/requireRole() 均返回 (req, res, next) => void 闭包, 在 route-registry 中用 middleware: [requireAuth()] 数组挂载"
        ],
        "gotchas": [
          "不可删除 middleware/auth.ts 中 generateAnonymousId (L56-62) — SEC-009: 匿名审计标识, 下游用于 audit log 无用户追踪。修改 hash 算法会破坏匿名 ID 一致性 (IP+UA+date 不变则 ID 不变)"
        ],
        "modelTier": "standard"
      },
      {
        "id": "ac-middleware-ext",
        "implementationNotes": "requireNotGuest 检查 req.user.role !== 'Guest'，否则返回 403。checkOwnership 通过 model 名称动态查询 prisma[model].findUnique，检查 creatorId/createdBy 是否匹配当前用户，Admin 角色跳过检查。workspaceAuth 读取 Bearer token → sha256 hash → 查 WorkspaceToken 表 → 注入 req.workspace。",
        "architectureContext": {
          "functions": [
            "requireNotGuest(): (req, res, next) => void @ middleware/auth.ts:308-321",
            "checkOwnership(model: string, paramKey?: string): (req, res, next) => void @ middleware/auth.ts:247-303",
            "workspaceAuth(): (req, res, next) => void @ middleware/auth.ts:328-383"
          ],
          "callChain": "routes.ts POST /logout → requireAuth → requireNotGuest → handler; workspaceAuth 用于 Daemon 端点",
          "imports": [
            "import { prisma } from '@dommaker/studio-prisma'",
            "import crypto from 'crypto'"
          ],
          "typesInScope": [
            "AuthRequest (Express) — extends Request { user?, session?, anonymousId?, workspace?, workspaceToken? }"
          ],
          "testMock": [],
          "dangerZones": [
            "middleware/auth.ts:L274 — checkOwnership 使用 (prisma as any)[model].findUnique, 传入无效 model 名会导致运行时错误"
          ],
          "verifiedAt": "无独立单元测试；通过集成测试间接覆盖"
        },
        "codePatterns": [],
        "gotchas": [],
        "modelTier": "standard"
      },
      {
        "id": "ac-rate-limit",
        "implementationNotes": "基于 express-rate-limit 中间件实现。authRateLimit 应用于登录/注册端点（windowMs=60s, max=10），refreshRateLimit 应用于 refresh 端点（windowMs=60s, max=20）。均为 IP 级别限流。",
        "architectureContext": {
          "functions": [
            "authRateLimit — 10 req/min/IP (express-rate-limit middleware)",
            "refreshRateLimit — 20 req/min/IP (express-rate-limit middleware)"
          ],
          "callChain": "auth/routes.ts 端点 handler 数组 → authRateLimit/refreshRateLimit 中间件 → handler",
          "imports": [
            "import rateLimit from 'express-rate-limit'",
            "import { authRateLimit, refreshRateLimit } from '../../middleware/rate-limit.js'"
          ],
          "typesInScope": [],
          "testMock": [],
          "dangerZones": [],
          "verifiedAt": "集成在 auth endpoint E2E 测试中"
        },
        "codePatterns": [],
        "gotchas": [
          "不可修改 rate-limit.ts authRateLimit 的 10/min 上限 — 暴力破解防护阈值, 需安全评审才能放松"
        ],
        "modelTier": "fast"
      }
    ]
  },
  "task": {
    "acGroups": [
      {
        "id": "ac-jwt-core",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/service.test.ts",
            "content": "// verifyToken: null return for invalid/empty/non-JWT strings (L256-259, L424-431)——tests return-null-no-throw contract"
          },
          {
            "file": "apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts",
            "content": "// requireAuth/optionalAuth call verifyToken internally, exercising JWT verify success path via valid tokens"
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/service.test.ts",
          "apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts"
        ],
        "contractTestsSkipReason": ""
      },
      {
        "id": "ac-password-config",
        "contractTests": [],
        "testFiles": [],
        "contractTestsSkipReason": "内部辅助函数 (hashPassword/verifyPassword) 与部署配置 (JWT_SECRET)，通过 login/register 集成测试间接覆盖。PBKDF2 兼容路径由 verifyPassword 代码审查保证。JWT_SECRET 启动阻断为 process-level 逻辑，由部署 smoke test 覆盖。"
      },
      {
        "id": "ac-session",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/service.test.ts",
            "content": "// createGuestSession: L65-100 (with/without guestId). login guest cleanup: L163-217 (findMany + deleteMany called correctly, skipped when no guests). getCurrentUser: L262-283 (expired→null, valid→user+session)"
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/service.test.ts"
        ],
        "contractTestsSkipReason": ""
      },
      {
        "id": "ac-session-utils",
        "contractTests": [],
        "testFiles": [],
        "contractTestsSkipReason": "getOrCreateSession 为内部辅助函数，通过 POST /guest-session 路由 E2E 测试间接覆盖 (auth-flow.e2e.test.ts L43-51)。cleanupExpiredSessions 为 Admin 端点 (POST /auth/cleanup)，无独立单元测试，依赖路由集成测试。"
      },
      {
        "id": "ac-auth-endpoints",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/service.test.ts",
            "content": "// register: L220-252 (email dup→409, success→user+session+token+isNewUser). login: L103-217 (user not found→throw, no passwordHash→throw, wrong pw→throw, valid→user+token+refreshToken)"
          },
          {
            "file": "apps/api/tests/auth-flow.e2e.test.ts",
            "content": "// Full endpoint E2E: guest-session (L43-51), register (L53-67), login (L85-100), me (L69-83), logout (L117-126), refresh (L102-115), full cycle (L128-145). All 5 auth endpoints exercised."
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/service.test.ts",
          "apps/api/tests/auth-flow.e2e.test.ts"
        ],
        "contractTestsSkipReason": ""
      },
      {
        "id": "ac-refresh-token",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/service.test.ts",
            "content": "// generateRefreshToken: L324-332 (creates token, length>0, prisma called). exchangeRefreshToken: L334-404 (revoked→null, expired→null, nonexistent→null, valid→new pair with old token revoked). revokeRefreshToken: L356-421 (already-revoked→false, valid→true with update called)."
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/service.test.ts"
        ],
        "contractTestsSkipReason": ""
      },
      {
        "id": "ac-refresh-client",
        "contractTests": [],
        "testFiles": [],
        "contractTestsSkipReason": "前端 axios interceptor (web/api/index.ts:70-130) 为浏览器端代码，不在 API 测试范围内。refresh 端点速率限制 (refreshRateLimit 20/min/IP) 为 express-rate-limit 中间件配置，集成在路由层，无独立单元测试。"
      },
      {
        "id": "ac-oauth",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/oauth.service.test.ts",
            "content": "// 258 行单元测试: getAuthorizationUrl URL 构建 (Google/GitHub params, unsupported provider, redirect_uri), exchangeCodeForTokens (unsupported provider), getOrCreateOAuthUser (existing account→return user, new→create user+OAuthAccount, email match→link), createOAuthSession (returns token+refreshToken), OAuth URL fragment test (tokens in # not ?)"
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/oauth.service.test.ts"
        ],
        "contractTestsSkipReason": ""
      },
      {
        "id": "ac-middleware-core",
        "contractTests": [
          {
            "file": "apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts",
            "content": "// 164 行: requireAuth() returns function not factory, calls next() with valid token, returns 401 without token. requireRole('Admin') returns 403 for User role, calls next() for Admin role. optionalAuth() returns function not factory, calls next() without token, calls next() with valid token."
          }
        ],
        "testFiles": [
          "apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts"
        ],
        "contractTestsSkipReason": ""
      },
      {
        "id": "ac-middleware-ext",
        "contractTests": [],
        "testFiles": [],
        "contractTestsSkipReason": "requireNotGuest/checkOwnership/workspaceAuth 已实现在 middleware/auth.ts 中 (L247-383)，但 middleware-invocation.test.ts 仅覆盖 requireAuth/optionalAuth/requireRole。这些扩展中间件通过集成测试间接覆盖，无独立单元测试文件。"
      },
      {
        "id": "ac-rate-limit",
        "contractTests": [],
        "testFiles": [],
        "contractTestsSkipReason": "速率限制测试集成在 auth endpoint E2E 流程中，无独立 test 文件"
      }
    ]
  }
}
```
