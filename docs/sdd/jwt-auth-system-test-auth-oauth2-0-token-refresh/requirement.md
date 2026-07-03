---
id: "cmqj7g0mx02gqmekj45bvs69i"
slug: "jwt-auth-system-test-auth-oauth2-0-token-refresh"
title: "JWT 认证系统测试覆盖补全 — Auth + OAuth2.0 + Token 刷新"
status: "implemented"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
sourceChannelId: "cmqgvblj6000mhqtioulyu771"
tags: ["auth", "oauth2", "jwt", "token-refresh", "test-coverage", "analyst"]
createdAt: "2026-06-18T07:55:13.558Z"
updatedAt: "2026-06-18T07:55:13.558Z"
---

## JWT 认证系统测试覆盖补全 — Auth + OAuth2.0 + Token 刷新

核心 JWT 认证系统（登录/注册/访客会话/Token刷新/OAuth2.0 Google+GitHub登录/中间件鉴权）已实现，但存在大量测试覆盖缺口。本需求补全 auth 模块和 analyst 相关模块的单元测试与集成测试，覆盖边界路径、错误处理和未测试的私有函数路径。

## AC Groups

### acg-auth-service-edge

#### 验收标准
- [ ] 验证 getOrCreateSession() 正常创建新 session 和返回已有有效 session
- [ ] 验证 cleanupExpiredSessions() 正确清理过期 session 并保留有效 session
- [ ] 验证 verifyPassword() 正确处理 PBKDF2 旧格式（salt:hash 解析、needsRehash 返回、不合法格式抛错）
- [ ] 验证 login() 中 needsRehash 为 true 时静默升级密码哈希
- [ ] 验证 hashPassword() 直接调用返回 bcrypt 哈希字符串

#### 涉及文件
- apps/api/src/modules/auth/__tests__/service-edge.test.ts

#### 依赖

### acg-oauth-code-exchange

#### 验收标准
- [ ] 验证 exchangeCodeForTokens('google', code) 通过 global.fetch mock 成功交换 token
- [ ] 验证 exchangeCodeForTokens('google', code) 处理 Google API 返回 error 的失败路径
- [ ] 验证 exchangeCodeForTokens('github', code) 通过 global.fetch mock 成功交换 token
- [ ] 验证 exchangeCodeForTokens('github', code) 处理 GitHub /user/emails fallback 路径（主 email 为空时）
- [ ] 验证 exchangeCodeForTokens('github', code) 处理 GitHub API 返回 error 的失败路径
- [ ] 验证 exchangeCodeForTokens 对不支持的 provider 抛出明确错误

#### 涉及文件
- apps/api/src/modules/auth/__tests__/oauth.code-exchange.test.ts

#### 依赖

### acg-auth-routes-integration

#### 验收标准
- [ ] 验证 POST /auth/guest-session 成功创建访客会话并返回 accessToken + refreshToken
- [ ] 验证 POST /auth/register 成功注册新用户并返回 tokens
- [ ] 验证 POST /auth/register 处理重复邮箱注册的 409 错误
- [ ] 验证 POST /auth/login 成功登录并返回 tokens
- [ ] 验证 POST /auth/login 处理错误密码的 401 错误
- [ ] 验证 POST /auth/logout 成功登出并清除 session
- [ ] 验证 GET /auth/me 返回当前用户信息（有有效 token）
- [ ] 验证 GET /auth/me 无 token 时返回 401
- [ ] 验证 POST /auth/refresh 通过 refreshToken 换发新 accessToken
- [ ] 验证 POST /auth/refresh 过期 refreshToken 返回 401
- [ ] 验证 POST /auth/cleanup 管理员角色可成功清理过期 session
- [ ] 验证 POST /auth/cleanup 非管理员角色返回 403
- [ ] 验证 AuditService 在 route handler 中被正确调用（login/register/logout）

#### 涉及文件
- apps/api/src/modules/auth/__tests__/routes.test.ts

#### 依赖: acg-auth-service-edge

### acg-oauth-routes-integration

#### 验收标准
- [ ] 验证 GET /auth/oauth/:provider 重定向到 OAuth 授权页面并设置 CSRF state cookie
- [ ] 验证 GET /auth/oauth/:provider/callback state 不匹配时重定向到 oauth_failed
- [ ] 验证 GET /auth/oauth/:provider/callback 缺少 state cookie 时重定向到 oauth_failed
- [ ] 验证 GET /auth/oauth/:provider/callback 缺少 code 参数时重定向到 oauth_failed
- [ ] 验证 GET /auth/oauth/:provider/callback exchangeCode 失败时重定向到 oauth_failed
- [ ] 验证 GET /auth/oauth/:provider/callback 成功交换 code 后创建/关联用户并重定向成功

#### 涉及文件
- apps/api/src/modules/auth/__tests__/oauth.routes.test.ts

#### 依赖: acg-oauth-code-exchange

### acg-middleware-additional

#### 验收标准
- [ ] 验证 checkOwnership() 对 resource.creatorId === userId 放行 next()
- [ ] 验证 checkOwnership() 对 resource.createdBy === userId 放行 next()（旧格式兼容）
- [ ] 验证 checkOwnership() admin 角色 bypass 所有权检查
- [ ] 验证 checkOwnership() 资源不存在时返回 404
- [ ] 验证 checkOwnership() 资源不属于当前用户且非 admin 时返回 403
- [ ] 验证 requireNotGuest() 对 role=guest 的用户返回 403
- [ ] 验证 requireNotGuest() 对 role=user/admin 的用户放行 next()
- [ ] 验证 workspaceAuth() 通过 tokenHash 查找有效 workspace session 并注入 req.workspace
- [ ] 验证 workspaceAuth() session revokedAt 不为 null 时返回 401
- [ ] 验证 generateAnonymousId() 同一 date window 内相同 IP 返回相同 ID
- [ ] 验证 generateAnonymousId() 不同 IP 返回不同 ID
- [ ] 验证 requireAuth() session 不存在时返回 401 且 body 含正确 JSON 错误信息
- [ ] 验证 requireAuth() session 过期时返回 401 且 body 含正确 JSON 错误信息
- [ ] 验证 requireRole() 传入多角色数组时任一匹配即放行
- [ ] 验证 requireRole() 用户不存在时返回 401

#### 涉及文件
- apps/api/src/modules/auth/__tests__/middleware-additional.test.ts

#### 依赖

### acg-analyst-knowledge

#### 验收标准
- [ ] 验证 analyst-knowledge 模块正确加载和查询本地知识库
- [ ] 验证知识查询在空知识库时返回合理默认值
- [ ] 验证知识查询处理格式错误的知识条目不崩溃

#### 涉及文件
- apps/api/src/modules/channels/__tests__/analyst-knowledge.test.ts

#### 依赖

### acg-analyst-prompt

#### 验收标准
- [ ] 验证 analyst-prompt 模板正确生成包含所需字段的系统提示
- [ ] 验证模板处理空输入（空上下文、空知识）不崩溃
- [ ] 验证模板处理超长输入（接近 token 上限）时正确截断

#### 涉及文件
- apps/api/src/modules/channels/__tests__/analyst-prompt.test.ts

#### 依赖

### acg-analyst-trigger

#### 验收标准
- [ ] 验证 analyst-trigger.service.ts trigger 方法正确调用下游分析管线
- [ ] 验证 trigger 处理输入为空/null 时不崩溃并返回合理错误
- [ ] 验证 trigger 处理下游服务超时/失败时的错误传播

#### 涉及文件
- apps/api/src/modules/channels/__tests__/analyst-trigger.test.ts

#### 依赖: acg-analyst-knowledge, acg-analyst-prompt


## Files

- apps/api/src/modules/auth/__tests__/service-edge.test.ts
- apps/api/src/modules/auth/__tests__/oauth.code-exchange.test.ts
- apps/api/src/modules/auth/__tests__/routes.test.ts
- apps/api/src/modules/auth/__tests__/oauth.routes.test.ts
- apps/api/src/modules/auth/__tests__/middleware-additional.test.ts
- apps/api/src/modules/channels/__tests__/analyst-knowledge.test.ts
- apps/api/src/modules/channels/__tests__/analyst-prompt.test.ts
- apps/api/src/modules/channels/__tests__/analyst-trigger.test.ts