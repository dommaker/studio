---
id: "cmqj74ncd01yjmekjrvuj9nwa"
slug: "jwt-authentication-system-with-token-refresh-and-o"
title: "JWT Authentication System with Token Refresh and OAuth2.0 Third-Party Login"
status: "implemented"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
sourceChannelId: "cmqgvblj6000mhqtioulyu771"
tags: ["auth", "jwt", "oauth2", "security", "test-coverage"]
createdAt: "2026-06-18T07:46:22.759Z"
updatedAt: "2026-06-18T07:46:22.759Z"
---

## JWT Authentication System with Token Refresh and OAuth2.0 Third-Party Login

实现基于JWT的用户认证系统，包含：用户注册/登录/登出、guest session创建、access token签发与验证、refresh token轮换机制、OAuth2.0第三方登录（Google/GitHub）、会话生命周期管理。核心service层已实现并通过单元测试，缺口集中在路由层测试、中间件补充测试、OAuth token交换的具体provider路径测试、service边界情况测试。

## AC Groups

### acg-auth-routes

#### 验收标准
- [ ] 为 routes.ts 的全部 handler（guest-session/register/login/logout/me/cleanup/refresh）编写单元测试，覆盖正常路径和错误码映射
- [ ] 验证 auditService (SEC-010) 在 login/logout/register 操作中被正确调用
- [ ] 测试 rate-limit 中间件在路由层的集成行为
- [ ] 确认所有 handler 的错误响应格式一致（{ error: string, code: string }）

#### 涉及文件
- apps/api/src/modules/auth/routes.ts
- apps/api/src/modules/auth/__tests__/routes.test.ts

#### 依赖: acg-auth-service-edge

### acg-oauth-routes

#### 验收标准
- [ ] 为 oauth.routes.ts 的 provider redirect handler 和 callback handler 编写单元测试
- [ ] 测试 CSRF state 校验逻辑（state 不匹配时拒绝请求）
- [ ] 测试 state cookie 的设置和读取（SameSite/HttpOnly/Secure 属性）
- [ ] 测试 OAuth callback 成功后 redirect URL 构建逻辑

#### 涉及文件
- apps/api/src/modules/auth/oauth.routes.ts
- apps/api/src/modules/auth/__tests__/oauth.routes.test.ts

#### 依赖: acg-oauth-exchange

### acg-middleware-remaining

#### 验收标准
- [ ] 为 checkOwnership 编写单元测试（资源所有权验证逻辑）
- [ ] 为 requireNotGuest 编写单元测试（guest 用户拦截）
- [ ] 为 workspaceAuth 编写单元测试（workspace 级别权限控制）
- [ ] 为 generateAnonymousId 编写单元测试（匿名 ID 生成格式和唯一性）

#### 涉及文件
- apps/api/src/modules/auth/middleware/auth.ts
- apps/api/src/modules/auth/__tests__/middleware-auth.test.ts

#### 依赖

### acg-service-edge

#### 验收标准
- [ ] 为 getOrCreateSession 编写单元测试（新建 session 和复用已有 session 两条路径）
- [ ] 为 cleanupExpiredSessions 编写单元测试（过期 session 清理、批量删除验证）
- [ ] 为 verifyPassword 的 PBKDF2 旧格式路径编写单元测试（兼容老密码哈希）
- [ ] 为 hashPassword 编写单元测试（输出 bcrypt 格式验证、salt 随机性）

#### 涉及文件
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/__tests__/service-edge.test.ts

#### 依赖

### acg-oauth-exchange

#### 验收标准
- [ ] 为 exchangeCodeForTokens 的 Google provider 路径编写单元测试（mock fetch 模拟令牌交换）
- [ ] 为 exchangeCodeForTokens 的 GitHub provider 路径编写单元测试（mock fetch 模拟令牌交换）
- [ ] 测试 access_token 解析和用户信息获取流程
- [ ] 测试 exchange 失败时的错误处理（无效 code、网络超时、provider 返回错误）

#### 涉及文件
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts

#### 依赖


## Files

- apps/api/src/modules/auth/routes.ts
- apps/api/src/modules/auth/__tests__/routes.test.ts
- apps/api/src/modules/auth/oauth.routes.ts
- apps/api/src/modules/auth/__tests__/oauth.routes.test.ts
- apps/api/src/modules/auth/middleware/auth.ts
- apps/api/src/modules/auth/__tests__/middleware-auth.test.ts
- apps/api/src/modules/auth/service.ts
- apps/api/src/modules/auth/__tests__/service-edge.test.ts
- apps/api/src/modules/auth/oauth.service.ts
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts