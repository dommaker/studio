---
id: "cmr01qh13005mg9d8dhfxakqf"
slug: "jwt-auth-system-token-refresh-oauth2-0"
title: "JWT 认证系统（Token 刷新 + OAuth2.0 第三方登录）"
status: "implemented"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
sourceChannelId: "cmquyaqht0000u6uz20ht878l"
tags: ["auth", "jwt", "oauth2", "security", "session", "rate-limiting", "csrf"]
createdAt: "2026-06-30T02:47:27.987Z"
updatedAt: "2026-06-30T02:47:27.987Z"
---

## JWT 认证系统（Token 刷新 + OAuth2.0 第三方登录）

实现完整的用户认证系统：JWT access token 签发与验证、refresh token 轮转机制、Google/GitHub OAuth2.0 第三方登录、Guest session 管理、邮箱密码注册/登录、密码重置流程、速率限制、CSRF 防护、审计日志、前端 401 自动刷新拦截器。系统已完整实现并经过多轮安全加固（6 个 SDD 目录的 gap-closure 修复）。

## AC Groups

### ac-jwt-core

#### 验收标准
- [ ] 签发 JWT access token，payload 固定 { sid: sessionId, uid?: userId } 短字段格式
- [ ] 验证 JWT token 并解析 sessionId/userId，过期/tampered token 返回 null
- [ ] JWT_SECRET 生产环境从环境变量读取，缺失则启动阻断 throw Error
- [ ] JWT 过期时间 7 天（JWT_EXPIRES_IN_SECONDS = 7*24*60*60），前端无 JWT payload 解析，所有判断靠 /auth/me 端点
- [ ] 密码哈希使用 bcryptjs (cost=12)，同时兼容旧 PBKDF2 salt:hash 格式，旧格式验证通过触发 needsRehash 静默升级
- [ ] JWT payload 字段名 {sid, uid} 不可改为 {sessionId, userId}，下游 middleware/auth.ts 用 payload.sid 查 session

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/api/src/middleware/auth.ts

#### 依赖

### ac-auth-endpoints

#### 验收标准
- [ ] POST /auth/register 创建用户（email + password + optional name），返回 AuthResult（含 accessToken + refreshToken）
- [ ] POST /auth/login 验证凭证后返回 AuthResult，登录前清理该用户所有有效 guest session（findMany + deleteMany）
- [ ] POST /auth/logout 立即过期当前 session（设置 expiresAt=now），如提供 userId 同步吊销所有 refresh token
- [ ] GET /auth/me 返回当前用户和 session 信息（optionalAuth），未登录返回 { user: null, session: null }
- [ ] POST /auth/guest-session 创建或获取匿名 session（24h 过期），基于 guestId 复用已有有效 session
- [ ] POST /auth/cleanup 清理过期 session（requireAuth + requireRole('Admin') 守卫）
- [ ] POST /auth/forgot-password 生成重置 token 并发送邮件，统一返回成功不暴露邮箱是否存在
- [ ] POST /auth/reset-password 使用 token 重置密码，token 无效或过期返回错误
- [ ] AuthResult 必须包含 refreshToken 字段 —— 前端 authStore 依赖此字段进行 401 自动刷新
- [ ] register 中 role hardcode 为 'User'，新增用户创建路径时必须显式设 role（schema 默认值是 'Guest'）

#### 涉及文件
- apps/api/src/modules/auth/routes.ts
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/email.service.ts

#### 依赖: ac-jwt-core

### ac-refresh-token

#### 验收标准
- [ ] POST /auth/refresh 接收 refreshToken，验证有效性后吊销旧 token + 创建新 session + 新 accessToken + 新 refreshToken（rotation）
- [ ] exchangeRefreshToken 并发安全：使用 updateMany where { id, revokedAt: null } 原子吊销，revoke.count===0 时返回 null 拒绝重复消费
- [ ] Refresh token 过期时间 30 天（独立于 JWT 7 天和 session 过期）
- [ ] logout 时如提供 userId 则批量吊销该用户所有 refresh token（updateMany where userId set revokedAt）
- [ ] RefreshToken.revokedAt 已有值时 updateMany 幂等 —— 重复撤销安全
- [ ] refresh 端点排除自身（加入 AUTH_PATHS），防止 refresh 失败触发前端 interceptor 无限递归
- [ ] POST /auth/refresh 返回 { accessToken, refreshToken, userId } —— 字段名是 accessToken 不是 token

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/routes.ts

#### 依赖: ac-jwt-core, ac-auth-endpoints

### ac-oauth

#### 验收标准
- [ ] GET /auth/:provider(google|github) 重定向到 OAuth 授权页面，携带 crypto.randomBytes(32) CSRF state
- [ ] GET /auth/callback/:provider 处理回调：验证 CSRF state → 交换 authorization code → 获取用户 profile → 创建/关联 User
- [ ] OAuth 用户解析三路径：按 OAuthAccount 查找 → 按 email 关联现有 User → 创建新 User + OAuthAccount
- [ ] CSRF state 存储在 httpOnly cookie (oauth_state, SameSite=Lax, 10min)，secure 在生产环境开启
- [ ] state cookie 验证后立即 clearCookie 防止重放攻击
- [ ] OAuth 成功回调通过 URL fragment (#) 传 token 到前端，防止 Referer 泄漏（错误路径保持 query param）
- [ ] OAuth 使用原生 fetch + crypto 实现，不依赖 passport.js
- [ ] Google OAuth token endpoint 用 POST + form-urlencoded，GitHub 用 POST + JSON + Accept: application/json header
- [ ] redirect_uri 路径格式：${redirectBase}/callback/${provider}（不是 /${provider}/callback）
- [ ] OAuth session 过期时间 7 天（与 email/password 一致）
- [ ] Google id_token (JWT) 可解码获取 email/name，GitHub email 需额外请求 GET /api/user/emails (scope: user:email) 并筛选 primary+verified

#### 涉及文件
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/oauth.routes.ts

#### 依赖: ac-jwt-core, ac-session

### ac-session

#### 验收标准
- [ ] 两步 Session 写入：先 prisma.session.create（空 token）→ jwt.sign → prisma.session.update（写入 token），防止 DB 重建时 token 丢失
- [ ] Guest session 24h 过期（GUEST_EXPIRES_HOURS=24），用户 session 7 天过期
- [ ] login 时清理该用户所有有效 guest session（session.findMany + deleteMany），在 session.create 之前执行
- [ ] getOrCreateSession：有 guestId 时查找已有有效 session 复用，否则创建新 guest session
- [ ] 过期 session 由 POST /auth/cleanup 批量清理（Admin only）

#### 涉及文件
- apps/api/src/modules/auth/service.ts

#### 依赖: ac-jwt-core

### ac-security

#### 验收标准
- [ ] authRateLimit: login/register/forgot-password/reset-password 端点 10 req/min/IP
- [ ] refreshRateLimit: refresh 端点 20 req/min/IP
- [ ] Lurk Wall 全局认证墙：PUBLIC_API Set 白名单模式，production 环境仅对白名单路由放行
- [ ] 速率限制使用 express-rate-limit，默认 keyGenerator 使用 req.ip（需正确配置 trust proxy）
- [ ] 审计日志（SEC-010）：login/logout/register 成功/失败均记录（fire-and-forget，不阻断主流程）
- [ ] 日志不记敏感信息：token/secret 不进出日志，OAuth client_secret 脱敏
- [ ] 密码哈希可能为 null（OAuth-only 用户），verifyPassword 需处理 null 场景
- [ ] 不可删除 middleware/auth.ts 中 generateAnonymousId（SEC-009：匿名审计标识，下游用于 audit log）

#### 涉及文件
- apps/api/src/middleware/rate-limit.ts
- apps/api/src/middleware/auth.ts
- apps/api/src/app.ts

#### 依赖: ac-auth-endpoints

### ac-frontend

#### 验收标准
- [ ] axios request interceptor 自动注入 Bearer token（直接从 localStorage 读取 'auth-storage' key，避免循环依赖）
- [ ] axios response interceptor 侦测 401 → 自动 refresh → 用新 token 重试原请求
- [ ] 并发 401 排队：isRefreshing flag + failedQueue，首个 401 触发 refresh，后续 401 排队等待新 token 后批量重试
- [ ] refresh 请求使用独立 axios 实例（非 api 实例），防止 interceptor 递归死循环
- [ ] Auth 端点（login/register/guest-session/refresh/me/forgot-password/reset-password）排除在 AUTH_PATHS 中，不触发 401 refresh 逻辑
- [ ] refresh 成功后将新 token 写入 localStorage 并更新 authStore state
- [ ] refresh 失败则清空 localStorage auth-storage 并 reject 所有排队请求
- [ ] Interceptor 绝对不 import authStore（循环依赖：authStore.ts imports from '../api'），必须直接从 localStorage 读取
- [ ] POST /auth/refresh 返回字段名是 accessToken（不是 token），前端解析时匹配此字段名

#### 涉及文件
- apps/web/src/api/index.ts
- apps/web/src/stores/authStore.ts

#### 依赖: ac-refresh-token


## Files

- apps/api/src/modules/auth/service.ts
- apps/api/src/middleware/auth.ts
- apps/api/src/modules/auth/routes.ts
- apps/api/src/modules/auth/email.service.ts
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/oauth.routes.ts
- apps/api/src/middleware/rate-limit.ts
- apps/api/src/app.ts
- apps/web/src/api/index.ts
- apps/web/src/stores/authStore.ts