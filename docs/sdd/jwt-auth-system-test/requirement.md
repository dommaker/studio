---
id: "cmqj89zbi034lmekj4m74xaiu"
slug: "jwt-auth-system-test"
title: "JWT 认证系统测试覆盖补全 + 边界加固"
status: "implemented"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
sourceChannelId: "cmqgvblj6000mhqtioulyu771"
tags: ["auth", "jwt", "oauth2", "test-coverage", "security", "type-safety"]
createdAt: "2026-06-18T08:18:31.034Z"
updatedAt: "2026-06-18T08:18:31.034Z"
---

## JWT 认证系统测试覆盖补全 + 边界加固

核心 JWT 认证系统（token 签发/验证、refresh token 轮转、OAuth2.0 Google/GitHub 登录、中间件链、速率限制、CSRF 防护）已完整实现——8 个 AC 组覆盖全部功能模块，含单元测试 28+13+7=48 用例 + E2E 14 用例。本次需求聚焦剩余缺口：路由层测试、OAuth exchange 集成验证、扩展中间件测试、速率限制测试、并发 refresh 安全、前端组件测试、审计日志测试、PBKDF2 旧密码迁移路径覆盖。

## AC Groups

### ac-route-coverage

#### 验收标准
- [ ] 为 auth/routes.ts (201行) 编写路由级单元测试：覆盖 register/login/logout/me/guest-session 5 个端点的请求验证、状态码、错误响应映射
- [ ] 为 auth/routes.ts 编写审计日志记录验证测试：登录成功/失败、注册、登出事件均触发 AuditService 记录（SEC-010）
- [ ] 为 oauth/routes.ts (89行) 编写路由级单元测试：覆盖 CSRF state cookie 验证（有效/无效/缺失）、callback 错误 redirect（含 error query param）、成功 redirect（含 URL fragment）
- [ ] 验证 auth 端点速率限制中间件正确挂载：login/register 使用 authRateLimit(10/min)，refresh 使用 refreshRateLimit(20/min)

#### 涉及文件
- apps/api/src/modules/auth/routes.ts
- apps/api/src/modules/auth/oauth.routes.ts
- apps/api/src/middleware/rate-limit.ts

#### 依赖

### ac-middleware-ext-coverage

#### 验收标准
- [ ] 为 workspaceAuth() 编写单元测试：验证 Bearer token 提取 → sha256 hash → WorkspaceToken 表查询 → 注入 req.workspace 的完整调用链
- [ ] 为 checkOwnership(model, paramKey) 编写单元测试：覆盖 owner 匹配通过、非 owner 返回 403、Admin 角色跳过检查、无效 model 名运行时错误
- [ ] 为 requireNotGuest() 编写单元测试：覆盖 Guest 角色返回 403、非 Guest 角色放行
- [ ] 为 generateAnonymousId() 编写单元测试：验证 IP+UA+date 哈希一致性（SEC-009）

#### 涉及文件
- apps/api/src/middleware/auth.ts

#### 依赖

### ac-rate-limit-tests

#### 验收标准
- [ ] 为 authRateLimit 编写单元测试：验证 windowMs=60s、max=10、IP 级别限流配置正确
- [ ] 为 refreshRateLimit 编写单元测试：验证 windowMs=60s、max=20、IP 级别限流配置正确
- [ ] 验证速率限制中间件与 express-rate-limit 风格一致（与现有 mcpRateLimit/apiRateLimit 对比）

#### 涉及文件
- apps/api/src/middleware/rate-limit.ts

#### 依赖

### ac-oauth-exchange

#### 验收标准
- [ ] 为 exchangeGoogleCode 编写集成测试：mock fetch 模拟 Google token endpoint 成功/失败响应、profile endpoint 成功/失败响应
- [ ] 为 exchangeGitHubCode 编写集成测试：mock fetch 模拟 GitHub token endpoint + /user/emails endpoint（含 primary email null 的 fallback 路径）
- [ ] 验证 OAuth token exchange 错误分类：network error → 503、invalid code → 400、profile fetch fail → 502

#### 涉及文件
- apps/api/src/modules/auth/oauth.service.ts

#### 依赖

### ac-refresh-concurrency

#### 验收标准
- [ ] 为 exchangeRefreshToken 编写并发安全测试：模拟两个并发请求使用同一 refresh token，验证仅第一个成功、第二个返回 null（revokedAt 已设置）
- [ ] 验证 refresh token rotation 非事务包裹场景下的幂等性：重复撤销同一 token 不抛异常
- [ ] 验证前端 axios interceptor 并发 401 队列：isRefreshing flag + failedQueue 排队 → token 刷新后批量重试

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/web/src/api/index.ts

#### 依赖

### ac-frontend-coverage

#### 验收标准
- [ ] 为 authStore.ts (215行 Zustand store) 编写单元测试：覆盖 login/register/logout/refreshToken/getCurrentUser action + 状态变更
- [ ] 为 OAuthCallback.tsx (50行) 编写组件测试：覆盖 URL fragment 解析 → token 存储 → redirect 流程、错误 fragment 展示
- [ ] 为 axios interceptor 编写单元测试：覆盖 Bearer token 注入、401 → refresh → retry 流程、refresh 失败清除 auth state

#### 涉及文件
- apps/web/src/stores/authStore.ts
- apps/web/src/components/OAuthCallback.tsx
- apps/web/src/api/index.ts

#### 依赖

### ac-audit-logger

#### 验收标准
- [ ] 为 audit-logger.ts (145行) 编写单元测试：覆盖登录事件记录、角色变更记录、审计日志查询过滤
- [ ] 验证审计日志包含必要字段：timestamp、userId、action、ipAddress、userAgent

#### 涉及文件
- apps/api/src/middleware/audit-logger.ts

#### 依赖

### ac-password-migration

#### 验收标准
- [ ] 为 verifyPassword PBKDF2 旧格式兼容路径编写测试：验证 legacy PBKDF2 salt:hash 格式识别 → 验证通过 → needsRehash=true
- [ ] 验证 login 流程中 needsRehash 触发静默升级：旧格式密码登录成功后自动更新为 bcrypt 哈希
- [ ] 验证旧格式哈希迁移后新登录使用 bcrypt 路径（不再走 PBKDF2）

#### 涉及文件
- apps/api/src/modules/auth/service.ts

#### 依赖

### ac-no-any-cleanup

#### 验收标准
- [ ] 消除 auth 测试中 ~50+ 处 as any 类型断言：mock 对象改用 Prisma 类型或具体接口类型
- [ ] 消除 middleware/auth.ts L274 中 (prisma as any)[model] 动态访问：改用类型安全的 model 映射表

#### 涉及文件
- apps/api/src/modules/auth/__tests__/service.test.ts
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts
- apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts
- apps/api/src/middleware/auth.ts

#### 依赖


## Files

- apps/api/src/modules/auth/routes.ts
- apps/api/src/modules/auth/oauth.routes.ts
- apps/api/src/middleware/rate-limit.ts
- apps/api/src/middleware/auth.ts
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/service.ts
- apps/web/src/api/index.ts
- apps/web/src/stores/authStore.ts
- apps/web/src/components/OAuthCallback.tsx
- apps/api/src/middleware/audit-logger.ts
- apps/api/src/modules/auth/__tests__/service.test.ts
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts
- apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts