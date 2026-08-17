---
id: "cmqj7g0mx02gqmekj45bvs69i"
slug: "jwt-auth-system-test-auth-oauth2-0-token-refresh"
title: "JWT 认证系统测试覆盖补全 — Auth + OAuth2.0 + Token 刷新"
status: "done"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
createdAt: "2026-06-18T07:55:13.558Z"
updatedAt: "2026-06-18T07:55:13.558Z"
---

## Design

### acg-auth-service-edge

**Implementation Notes**
在 service-edge.test.ts 中 mock prisma 和 jsonwebtoken，直接导入 service.ts 的函数进行测试。verifyPassword 需要构造 PBKDF2 格式的哈希（salt:hash 用冒号分隔）来触发旧格式路径。needsRehash 路径通过 mock bcrypt.compare 返回 true 且设置 mock hash 为旧格式来触发。

**Architecture Context**
- Functions: hashPassword, verifyPassword, getOrCreateSession, cleanupExpiredSessions, createGuestSession, login, register, generateRefreshToken, exchangeRefreshToken, revokeRefreshToken, getCurrentUser, logout
- Call Chain: service.ts (pure functions) → prisma ORM → PostgreSQL
- Imports: @dommaker/studio-prisma, jsonwebtoken, bcrypt, crypto
- Danger Zones: PBKDF2 旧格式解析 — salt:hash 分隔符可能冲突, cleanupExpiredSessions 的 DELETE CASCADE 影响
- Verified At: service.test.ts 已有 24 个用例覆盖核心路径

**Code Patterns**
- PRNG-based token generation → crypto.randomBytes(32).toString('hex')
- bcrypt hash with saltRounds=12
- JWT sign with { sub, role, sessionId } payload

**Gotchas**
- bcrypt 是 C++ 原生模块，vi.mock 可能无法直接 mock — 需 mock 整个模块或使用 vi.hoisted
- PBKDF2 verify 需要同步计算比较，测试中需要真实 crypto 或 mock crypto.timingSafeEqual

### acg-oauth-code-exchange

**Implementation Notes**
mock global.fetch 返回 Google/GitHub OAuth token endpoint 的响应。GitHub 需要额外 mock /user/emails endpoint 用于 email fallback 路径。因为 exchangeGoogleCode 和 exchangeGitHubCode 是私有函数，通过 exchangeCodeForTokens 公开接口间接测试。

**Architecture Context**
- Functions: exchangeCodeForTokens, getAuthorizationUrl, getOrCreateOAuthUser, createOAuthSession
- Call Chain: oauth.service.ts → global.fetch → Google/GitHub OAuth API → prisma upsert/create → JWT sign → session create
- Imports: @dommaker/studio-prisma, jsonwebtoken, crypto
- Danger Zones: global.fetch mock 会影响所有测试 — 需要 afterEach restore, GitHub email 数组可能为空 — 需处理 /user/emails 返回 [] 的情况
- Verified At: oauth.service.test.ts 已有 13 个用例覆盖 getAuthorizationUrl + getOrCreateOAuthUser + createOAuthSession

**Code Patterns**
- OAuth state: crypto.randomBytes(16).toString('hex') + set cookie httpOnly
- Token exchange: POST application/x-www-form-urlencoded
- User upsert: prisma.oAuthAccount.upsert + prisma.user.upsert

**Gotchas**
- Google token endpoint 返回 id_token (JWT) 可直接解析用户信息，不需要额外 API 调用
- GitHub 可能不返回 expires_in → tokens.expiresAt 为 null
- mock global.fetch 需要按 URL 区分返回不同响应

### acg-auth-routes-integration

**Implementation Notes**
使用 supertest 或直接调用 route handler 函数并 mock req/res 对象。Mock AuditService 以验证审计日志调用。Mock rateLimit 中间件以绕过限流。每个端点需测试成功路径和至少一个失败路径。

**Architecture Context**
- Functions: guestSessionHandler, registerHandler, loginHandler, logoutHandler, meHandler, refreshHandler, cleanupHandler
- Call Chain: Express Router → rateLimit middleware → handler → AuthService → Prisma → response.json/status
- Imports: express, ../service.js, ../middleware/auth.js, ../../../middleware/audit.js
- Danger Zones: rateLimit 中间件会阻塞请求 — 需 mock 或绕过, AuditService.catch 路径需要验证错误时不阻断主流程
- Verified At: middleware-invocation.test.ts 已有 7 个用例覆盖 requireAuth/optionalAuth/requireRole 工厂函数

**Code Patterns**
- Route handler: async (req, res) => { try { ... } catch { res.status(500).json(...) } }
- Auth header: Bearer <token>
- Refresh token in request body JSON

**Gotchas**
- supertest 需要启动 Express app — 可考虑用 handler 函数直接测试 + mock req/res 简化
- AuditService 是异步的，验证调用时需 await 或使用 waitFor

### acg-oauth-routes-integration

**Implementation Notes**
Mock oauth.service.ts 函数和 cookie 操作。重点测试 CSRF state 验证流程 — 这是 OAuth 安全的关键环节。redirect URL 需验证是 fragment 还是 query 模式。

**Architecture Context**
- Functions: authorizationHandler, callbackHandler
- Call Chain: Express Router → authorizationHandler → oauthService.getAuthorizationUrl → res.redirect | callbackHandler → cookie check → state verify → oauthService.exchangeCodeForTokens → oauthService.getOrCreateOAuthUser → oauthService.createOAuthSession → res.redirect
- Imports: express, ../oauth.service.js, cookie
- Danger Zones: CSRF state 不匹配是安全漏洞 — 必须 100% 覆盖, redirect URL 模式错误会导致前端无法解析 token
- Verified At: oauth.service.test.ts 中验证了 redirect URL fragment 字符串拼接

**Code Patterns**
- State cookie: httpOnly, sameSite=lax, maxAge=600
- Callback: GET /auth/oauth/:provider/callback?code=xxx&state=yyy
- Success redirect: client_url#access_token=xxx&refresh_token=yyy

**Gotchas**
- cookie.parse 返回的是字符串，需在 mock 中返回正确格式
- res.redirect 被调用后 response 已发送，不能再写 header

### acg-middleware-additional

**Implementation Notes**
每个中间件函数独立测试。checkOwnership 需要 mock prisma 查询返回不同资源类型。workspaceAuth 需要构造 tokenHash 查找逻辑。generateAnonymousId 需要 mock Date 以控制时间窗口。

**Architecture Context**
- Functions: checkOwnership, requireNotGuest, workspaceAuth, generateAnonymousId, requireAuth, optionalAuth, requireRole
- Call Chain: middleware factory → return (req, res, next) → verifyToken → prisma lookup → inject req.user/workspace → next() or res.status(401/403/404)
- Imports: jsonwebtoken, @dommaker/studio-prisma, crypto
- Danger Zones: checkOwnership 中 admin bypass 可能被滥用 — 需验证 role 字段来源为 JWT payload, workspaceAuth tokenHash 泄露风险 — 确保只查 hash 不存明文
- Verified At: middleware-invocation.test.ts 已验证 requireAuth/optionalAuth/requireRole 基本路径

**Code Patterns**
- Middleware factory: export const requireAuth = () => async (req, res, next) => { ... }
- Token extraction: req.headers.authorization?.replace('Bearer ', '')
- Resource lookup: prisma.<model>.findUnique({ where: { id: req.params.id } })

**Gotchas**
- checkOwnership 接受 model 参数指定 prisma model 名，需 mock 动态属性访问
- generateAnonymousId 使用 date window（当天），跨天测试需 vi.useFakeTimers

### acg-analyst-knowledge

**Implementation Notes**
analyst-knowledge.ts 目前无专用测试文件。需要创建独立测试，mock fs 和路径解析，验证知识加载、查询和边界处理。

**Architecture Context**
- Functions: loadKnowledge, queryKnowledge, searchKnowledge
- Call Chain: analyst-knowledge.ts → fs.readFileSync / fs.readdirSync → parse markdown → return structured knowledge
- Imports: fs, path, ../../../utils/logger.js
- Danger Zones: fs 同步读取可能阻塞事件循环, markdown 解析对格式敏感 — 边界输入需验证
- Verified At: 仅在 analyst executor 测试中通过 vi.mock('../analyst-knowledge.js') 间接使用

**Code Patterns**
- Synchronous file reading with try-catch
- Markdown section parsing by ## headers
- Result deduplication by entry ID

**Gotchas**
- vi.mock('fs') 需要 mock readFileSync 返回字符串或抛 Error
- 知识条目路径依赖 __dirname，需在 mock 中保持一致

### acg-analyst-prompt

**Implementation Notes**
analyst-prompt.ts 无专用测试文件。需要验证 prompt 模板生成逻辑，确保不同输入（空上下文、超长上下文、特殊字符）产生正确的模板输出。

**Architecture Context**
- Functions: buildSystemPrompt, buildUserPrompt, truncateContext
- Call Chain: analyst-prompt.ts → template string interpolation → return prompt string
- Imports: N/A
- Danger Zones: 超长上下文可能超出模型 token 限制, 特殊字符（{}\`）可能导致模板解析错误
- Verified At: 无独立测试，仅在其他模块中间接使用

**Code Patterns**
- Template literal with tagged templates
- Token counting estimation: Math.ceil(text.length / 4)
- Section truncation by priority order

**Gotchas**
- token 计数是估算值（char/4），非精确 tokenizer
- 截断时需保持 JSON/Markdown 结构完整性

### acg-analyst-trigger

**Implementation Notes**
analyst-trigger.service.ts 无专用测试文件。需要 mock 下游分析管线调用（prescan → scout → synthesizer），验证 trigger 主流程和错误传播。

**Architecture Context**
- Functions: trigger, triggerAnalysis, handleTriggerError
- Call Chain: analyst-trigger.service.ts → analyst-prescan → analyst-scout → analyst-synthesizer → return AnalysisResult
- Imports: ../analyst-prescan.js, ../analyst-scout.js, ../analyst-synthesizer.js, ../../../utils/logger.js
- Danger Zones: 下游服务超时可能造成请求堆积, 部分失败时中间状态可能不一致
- Verified At: 在 conversation-converter.test.ts 中通过 mock 间接使用

**Code Patterns**
- Pipeline pattern: sequential stage execution with early return on error
- Error aggregation: collect all errors before returning
- Timeout handling: Promise.race with AbortController

**Gotchas**
- trigger 可能是异步长任务，测试需处理 Promise 时序
- mock 下游函数需要按调用顺序返回不同值模拟 pipeline 阶段
