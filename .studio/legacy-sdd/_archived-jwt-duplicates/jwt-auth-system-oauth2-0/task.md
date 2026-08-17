---
id: "sdd-1782806674865-jl26wk"
slug: "jwt-auth-system-oauth2-0"
title: "JWT 用户认证系统 + OAuth2.0 第三方登录"
status: "done"
tier: "premium"
version: 6
requirementVersion: 1
designVersion: 1
taskVersion: 6
parentId: "sdd-1782574335954-y7sw36"
changeType: "L3"
createdAt: "2026-06-18T07:51:48.556Z"
updatedAt: "2026-06-30T08:04:34.865Z"
---

## Contract Tests

### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
// 已存在 434 行单元测试: createGuestSession/login/register/verifyToken/getCurrentUser/logout/refresh
// 覆盖: JWT sign/verify 正常路径, bcrypt hash/compare, PBKDF2 旧格式兼容
```
### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
// 覆盖: createGuestSession 正常/无 guestId, getOrCreateSession 复用/新建, login 后 guest session 清理, logout session 删除
```
### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
// 覆盖: register email 重复拒绝, login 密码错误拒绝, login 成功返回 AuthResult
```
### apps/api/tests/auth-flow.e2e.test.ts
```typescript
// 覆盖: guest → register → login → me → refresh → logout 全流程 E2E
```
### apps/api/src/modules/auth/__tests__/service.test.ts
```typescript
// 覆盖: generateRefreshToken, exchangeRefreshToken rotation (吊销旧+创建新), revokeRefreshToken
```
### apps/api/src/modules/auth/__tests__/oauth.service.test.ts
```typescript
// 258 行单元测试: getAuthorizationUrl URL 构建, exchangeCodeForTokens fetch mock, getOrCreateOAuthUser 新建/已有/email 匹配, createOAuthSession token 生成
```
### apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts
```typescript
// 164 行单元测试: requireAuth token 有效/无效/缺失, optionalAuth token 有效/无效/缺失, requireRole 允许/拒绝
```