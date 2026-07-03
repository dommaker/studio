---
id: "cmqwg891200sodsabq886u0vy"
slug: "auth-system-test"
title: "Auth 系统测试恢复与覆盖补全"
status: "implemented"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
sourceChannelId: "cmquyaqht0000u6uz20ht878l"
tags: ["auth", "testing", "oauth", "jwt", "test-restoration"]
createdAt: "2026-06-27T14:22:07.365Z"
updatedAt: "2026-06-27T14:22:07.365Z"
---

## Auth 系统测试恢复与覆盖补全

auth 模块的核心代码（JWT 认证、OAuth2.0、token 刷新）均已实现，但三个测试文件被删除（oauth.service.test.ts、oauth.routes.test.ts、routes.test.ts），另有部分边缘路径缺少测试覆盖。本需求恢复缺失的测试文件，补齐边缘覆盖缺口，确保 auth 模块测试覆盖率不低于 80%。

## AC Groups

### AC-GROUP-1

#### 验收标准
- [ ] 恢复 oauth.service.test.ts：覆盖 getAuthorizationUrl(provider, state) 对 Google 和 GitHub 返回正确 OAuth URL
- [ ] 恢复 oauth.service.test.ts：覆盖 exchangeCodeForTokens — fetch 请求成功/失败/非 ok 响应/畸形 JSON 分支
- [ ] 恢复 oauth.service.test.ts：覆盖 exchangeGoogleCode 和 exchangeGitHubCode 内部逻辑（网络错误、非 ok 响应、JSON 解析失败）
- [ ] 恢复 oauth.service.test.ts：覆盖 getOrCreateOAuthUser 三类路径（已存在 OAuth 账户、已有 email 匹配用户、全新用户创建 + upsert token 更新）
- [ ] 恢复 oauth.service.test.ts：覆盖 createOAuthSession（session 创建、JWT sign 调用、refresh token 生成）
- [ ] 恢复测试文件中的所有 mock 配置（vi.mock prisma、jsonwebtoken、global fetch、logger），确保每个测试用例独立且可并行运行

#### 涉及文件
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts

#### 依赖

### AC-GROUP-2

#### 验收标准
- [ ] 恢复 oauth.routes.test.ts：覆盖 GET /:provider → 生成 CSRF state cookie + 重定向到授权 URL
- [ ] 恢复 oauth.routes.test.ts：覆盖 GET /callback/:provider → code 缺失时错误重定向（含错误码映射）
- [ ] 恢复 oauth.routes.test.ts：覆盖 GET /callback/:provider → state 不匹配时错误重定向
- [ ] 恢复 oauth.routes.test.ts：覆盖 GET /callback/:provider → exchange 成功后 fragment 重定向（含 access_token/refresh_token 片段）
- [ ] 恢复 oauth.routes.test.ts：覆盖 GET /callback/:provider → catch 块异常处理（错误码映射 + 安全重定向）

#### 涉及文件
- apps/api/src/modules/auth/__tests__/oauth.routes.test.ts

#### 依赖: AC-GROUP-1

### AC-GROUP-3

#### 验收标准
- [ ] 恢复 routes.test.ts：覆盖 POST /guest-session（成功创建访客 session）
- [ ] 恢复 routes.test.ts：覆盖 POST /register（audit log 记录 + verification token 生成 + 409 email 冲突）
- [ ] 恢复 routes.test.ts：覆盖 POST /login（audit log 成功/失败分支 + 401 错误映射）
- [ ] 恢复 routes.test.ts：覆盖 POST /logout（audit log 记录）
- [ ] 恢复 routes.test.ts：覆盖 GET /me（有效 session + 无 session 边缘情况）
- [ ] 恢复 routes.test.ts：覆盖 POST /cleanup（清理过期 session）
- [ ] 恢复 routes.test.ts：覆盖 POST /refresh（缺少 body + 无效 token + 成功刷新）
- [ ] 恢复 routes.test.ts：覆盖 POST /forgot-password（缺少 email + 安全统一响应永不泄露用户存在性）
- [ ] 恢复 routes.test.ts：覆盖 POST /reset-password（缺少字段 + 过期 link）
- [ ] 恢复 routes.test.ts：覆盖 POST /send-verification（已验证用户 + 用户不存在）
- [ ] 恢复 routes.test.ts：覆盖 POST /verify-email（缺少 token + 过期 link）
- [ ] 恢复 routes.test.ts：验证所有端点的 rate limit 中间件被正确挂载（authRateLimit + refreshRateLimit）
- [ ] 恢复 routes.test.ts：使用 vi.hoisted mock 模式（mockGetAuthInfo + mockAuditLog），确保 hoisted mock 先于 vi.mock 定义

#### 涉及文件
- apps/api/src/modules/auth/__tests__/routes.test.ts

#### 依赖

### AC-GROUP-4

#### 验收标准
- [ ] 补充 service.test.ts：覆盖 getOrCreateSession 三个分支（已有未过期 guest session / 已有过期 guest session / 无 session 创建新 session）
- [ ] 补充 service.test.ts：覆盖 cleanupExpiredSessions（删除过期 session + 关联 refreshToken 级联清理）
- [ ] 补充 service.test.ts：覆盖 verifyEmail（未使用 token / 过期 token / $transaction 原子性）
- [ ] 补充 service.test.ts：覆盖 login 中 needsRehash 分支（password upgrade 时 prisma.user.update 静默失败后的行为）
- [ ] 补充 middleware-invocation.test.ts：覆盖 requireAuth 畸形 token（无 Bearer 前缀、token 解析失败）
- [ ] 补充 middleware-invocation.test.ts：覆盖 requireRole 缺少 user 信息时拒绝访问

#### 涉及文件
- apps/api/src/modules/auth/__tests__/service.test.ts
- apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts

#### 依赖


## Files

- apps/api/src/modules/auth/__tests__/oauth.service.test.ts
- apps/api/src/modules/auth/__tests__/oauth.routes.test.ts
- apps/api/src/modules/auth/__tests__/routes.test.ts
- apps/api/src/modules/auth/__tests__/service.test.ts
- apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts