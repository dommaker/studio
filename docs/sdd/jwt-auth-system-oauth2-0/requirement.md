---
id: "cmqj7bmjk02c4mekj4uhj9ae8"
slug: "jwt-auth-system-oauth2-0"
title: "JWT 用户认证系统 + OAuth2.0 第三方登录"
status: "implemented"
tier: "premium"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
sourceChannelId: "cmqgvblj6000mhqtioulyu771"
tags: ["auth", "jwt", "oauth", "security", "session", "refresh-token"]
createdAt: "2026-06-18T07:51:48.556Z"
updatedAt: "2026-06-18T07:51:48.556Z"
---

## JWT 用户认证系统 + OAuth2.0 第三方登录

实现基于 JWT 的用户认证系统，包含：JWT token 签发/验证、bcrypt 密码哈希、用户注册/登录/登出、Guest session 与匿名访问、Refresh token 轮换刷新机制、OAuth2.0 Google/GitHub 第三方登录、认证中间件链（requireAuth/optionalAuth/requireRole/workspaceAuth）、速率限制防护（10/min 登录、20/min 刷新）。前端 axios interceptor 自动处理 401 → refresh → retry 流程。

## AC Groups

### ac-jwt-core

#### 验收标准
- [ ] 签发 JWT token 时 payload 必须包含 { sid: sessionId, uid?: userId }，过期时间 7 天
- [ ] 验证 JWT token 返回 { sessionId, userId } 或 null，不抛异常
- [ ] 密码哈希使用 bcryptjs，支持旧 PBKDF2 格式兼容验证与静默升级
- [ ] JWT_SECRET 生产环境从环境变量读取，缺失则启动阻断

#### 涉及文件
- apps/api/src/modules/auth/service.ts

#### 依赖

### ac-session

#### 验收标准
- [ ] 创建 Guest session：接受 { guestId?, ipAddress?, userAgent? }，生成 JWT token 并持久化 Session 记录
- [ ] getOrCreateSession：按 IP+UA+guestId 查找已有 session 复用，否则创建新 session
- [ ] login 时自动清理该用户所有有效 Guest session（session.findMany + deleteMany）
- [ ] cleanupExpiredSessions 定时清理过期 session，返回清理数量
- [ ] getCurrentUser 通过 sessionId 查找当前用户与会话状态

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/routes.ts

#### 依赖: ac-jwt-core

### ac-auth-endpoints

#### 验收标准
- [ ] POST /api/v1/auth/register：接受 { email, password, name? }，email 唯一校验，bcrypt 哈希存储，role 默认 'User'
- [ ] POST /api/v1/auth/login：接受 { email, password }，验证密码，返回 token + refreshToken + user + session
- [ ] POST /api/v1/auth/logout：需 requireAuth，删除当前 session 及关联 refresh token
- [ ] GET /api/v1/auth/me：需 optionalAuth，返回当前 user + session 或 null
- [ ] POST /api/v1/auth/guest-session：创建匿名 guest session，返回 token + session

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/routes.ts
- apps/api/src/route-registry.ts

#### 依赖: ac-jwt-core, ac-session, ac-rate-limit

### ac-refresh-token

#### 验收标准
- [ ] generateRefreshToken 生成 30 天有效期的 refresh token 并持久化到 RefreshToken 表
- [ ] exchangeRefreshToken 同时执行：吊销旧 token → 创建新 session → 生成新 refresh token（rotation）
- [ ] revokeRefreshToken 吊销指定 refresh token（设置 revokedAt）
- [ ] 前端 axios interceptor：401 响应触发 refresh，并发请求排队避免重复刷新
- [ ] refresh 端点使用独立速率限制 20/min/IP

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/routes.ts
- apps/web/src/api/index.ts

#### 依赖: ac-jwt-core, ac-session

### ac-oauth

#### 验收标准
- [ ] GET /api/v1/auth/:provider(google|github)：生成 OAuth 授权 URL，httpOnly cookie 存 state 防 CSRF
- [ ] GET /api/v1/auth/callback/:provider(google|github)：验证 state cookie → exchange code → 获取 profile → 查找或创建用户 → 创建 session
- [ ] getOrCreateOAuthUser：按 provider+providerAccountId 查找已有 OAuth 账号，不存在则：email 匹配现有用户 → 链接，否则创建新用户 + OAuth 账号
- [ ] createOAuthSession：生成 JWT token + refresh token，token 通过 URL fragment (#) 传回前端避免 Referer 泄漏
- [ ] OAuth 原生实现，不依赖 passport.js

#### 涉及文件
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/oauth.routes.ts
- apps/api/src/route-registry.ts

#### 依赖: ac-jwt-core, ac-session, ac-refresh-token

### ac-middleware

#### 验收标准
- [ ] requireAuth：验证 JWT → 查找 session → 注入 req.user/req.session，失败返回 401
- [ ] optionalAuth：有 token 则验证注入，无 token 则 generateAnonymousId（IP+UA+date 哈希）注入 req.anonymousId
- [ ] requireRole(...roles)：在 requireAuth 后检查 req.user.role 是否在允许列表，不在返回 403
- [ ] requireNotGuest：拒绝 role='Guest' 的用户访问敏感端点
- [ ] checkOwnership(model, paramKey)：检查请求者是否拥有目标资源的访问权
- [ ] workspaceAuth：验证 workspace token 并注入 req.workspace

#### 涉及文件
- apps/api/src/middleware/auth.ts

#### 依赖: ac-jwt-core

### ac-rate-limit

#### 验收标准
- [ ] authRateLimit：登录/注册端点 10 次请求/分钟/IP，防暴力破解
- [ ] refreshRateLimit：refresh 端点 20 次请求/分钟/IP
- [ ] 速率限制基于 express-rate-limit 中间件

#### 涉及文件
- apps/api/src/middleware/rate-limit.ts
- apps/api/src/modules/auth/routes.ts

#### 依赖


## Files

- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/routes.ts
- apps/api/src/route-registry.ts
- apps/web/src/api/index.ts
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/oauth.routes.ts
- apps/api/src/middleware/auth.ts
- apps/api/src/middleware/rate-limit.ts