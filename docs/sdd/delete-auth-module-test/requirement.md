---
id: "cmqwgbwoe00t6dsab9cpf52td"
slug: "delete-auth-module-test"
title: "恢复已删除的 Auth 模块测试文件"
status: "implemented"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
sourceChannelId: "cmquyaqht0000u6uz20ht878l"
tags: ["auth", "test-restoration", "oauth", "jwt", "coverage"]
createdAt: "2026-06-27T14:24:58.016Z"
updatedAt: "2026-06-27T14:24:58.016Z"
---

## 恢复已删除的 Auth 模块测试文件

auth 模块的 JWT 认证 + OAuth2.0 第三方登录系统已完整实现并通过现有测试覆盖。3 个测试文件被删除（oauth.service.test.ts、oauth.routes.test.ts、routes.test.ts），需按已有实现和测试模式恢复，覆盖缺失的边界情况。不涉及新功能实现。

## AC Groups

### AC-GROUP-1

#### 验收标准
- [ ] 恢复 oauth.service.test.ts：覆盖 getAuthorizationUrl（Google/GitHub URL 格式、unsupported provider 报错、redirect_uri 拼接）
- [ ] 恢复 oauth.service.test.ts：覆盖 exchangeCodeForTokens（Google/GitHub 成功路径、invalid code 报错、profile fetch 失败、网络错误）
- [ ] 恢复 oauth.service.test.ts：覆盖 getOrCreateOAuthUser（已有 account 直接返回、新用户创建、email 关联已有用户、token upsert）
- [ ] 恢复 oauth.service.test.ts：覆盖 createOAuthSession（session 创建 + JWT 签发）
- [ ] 全部 OAuth service 测试通过，mock 模式对齐已有 service.test.ts 的 prisma mock 模式

#### 涉及文件
- apps/api/src/modules/auth/__tests__/oauth.service.test.ts

#### 依赖

### AC-GROUP-2

#### 验收标准
- [ ] 恢复 oauth.routes.test.ts：覆盖 GET /api/auth/oauth/:provider（state cookie 设置、302 redirect、500 on error）
- [ ] 恢复 oauth.routes.test.ts：覆盖 GET /api/auth/oauth/callback/:provider（CSRF 校验：missing code/missing state/state mismatch 均返回错误、cookie clearing）
- [ ] 恢复 oauth.routes.test.ts：覆盖 callback 成功路径（redirect with URL fragment 含 token、error redirect with query params）
- [ ] 恢复 oauth.routes.test.ts：覆盖 cookie 安全标志（secure in production、sameSite、httpOnly）
- [ ] 恢复 oauth.routes.test.ts：覆盖 error code mapping（provider 错误码到 API 错误响应的映射）

#### 涉及文件
- apps/api/src/modules/auth/__tests__/oauth.routes.test.ts

#### 依赖: AC-GROUP-1

### AC-GROUP-3

#### 验收标准
- [ ] 恢复 routes.test.ts：覆盖 POST /guest-session（成功创建、已存在 session 复用）
- [ ] 恢复 routes.test.ts：覆盖 POST /register（成功注册、duplicate email 409、弱密码拒绝）
- [ ] 恢复 routes.test.ts：覆盖 POST /login（成功返回 token、invalid credentials 401、已锁定账户拒绝）
- [ ] 恢复 routes.test.ts：覆盖 POST /logout（清除 session、清除 refreshToken）
- [ ] 恢复 routes.test.ts：覆盖 GET /me（有效 token 返回用户信息、无效 token 401、过期 token 401）
- [ ] 恢复 routes.test.ts：覆盖 POST /refresh（正常刷新、过期 token 401、并发刷新 race condition、revoked token 拒绝）
- [ ] 恢复 routes.test.ts：覆盖 POST /forgot-password（已存在 email 发送 token、不存在 email 静默成功防枚举）
- [ ] 恢复 routes.test.ts：覆盖 POST /reset-password（有效 token 重置、过期 token、已使用 token 拒绝）
- [ ] 恢复 routes.test.ts：覆盖 POST /send-verification（发送验证邮件）
- [ ] 恢复 routes.test.ts：覆盖 POST /verify-email（有效 token 验证、过期 token）
- [ ] 恢复 routes.test.ts：覆盖 POST /cleanup（清理过期 session）
- [ ] 恢复 routes.test.ts：验证所有路由已挂载 rate-limit 中间件
- [ ] 恢复 routes.test.ts：验证所有路由已挂载 audit logging（SEC-010 合规）

#### 涉及文件
- apps/api/src/modules/auth/__tests__/routes.test.ts

#### 依赖: AC-GROUP-1, AC-GROUP-2


## Files

- apps/api/src/modules/auth/__tests__/oauth.service.test.ts
- apps/api/src/modules/auth/__tests__/oauth.routes.test.ts
- apps/api/src/modules/auth/__tests__/routes.test.ts