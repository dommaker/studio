---
slug: db-removal-spec-1
title: DB 移除 Spec 1 - 死代码表清理 - 设计
status: draft
createdAt: 2026-07-15
type: migration
---

## 文件映射表

### AC-1: SignedDocument

| 文件路径 | 改动类型 | 说明 |
|---------|---------|------|
| `packages/studio-prisma/prisma/schema.prisma` | 删除 model | L171-194 |
| `apps/api/src/middleware/auth.ts` | 删除代码 | L250-253: `case 'signedDocument'` 分支 |
| `packages/studio-prisma/src/index.ts` | 删除条目 | L20: `SignedDocument: ['metadata', 'approvals']` |

### AC-2: OAuthAccount

| 文件路径 | 改动类型 | 说明 |
|---------|---------|------|
| `packages/studio-prisma/prisma/schema.prisma` | 删除 model + 关联 | L247-263 model, L210 User.oauthAccounts |
| `apps/api/src/modules/auth/oauth.service.ts` | 整文件删除 | 429 行 OAuth 服务 |
| `apps/api/src/modules/auth/oauth.routes.ts` | 整文件删除 | 108 行 OAuth 路由 |
| `apps/api/src/route-registry.ts` | 删除引用 | L39,59,170 |
| `apps/api/src/modules/auth/__tests__/oauth.service.test.ts` | 整文件删除 | |
| `apps/api/src/modules/auth/__tests__/oauth.routes.test.ts` | 整文件删除 | |
| `apps/web/src/components/OAuthCallback.tsx` | 整文件删除 | |
| `apps/web/src/components/__tests__/OAuthCallback.test.tsx` | 整文件删除 | |
| `apps/web/src/App.tsx` | 删除路由 | OAuth callback 路由 |
| `apps/web/src/components/AuthModal.tsx` | 删除代码 | OAuth 登录按钮 |

### AC-3: PasswordResetToken + EmailVerificationToken

| 文件路径 | 改动类型 | 说明 |
|---------|---------|------|
| `packages/studio-prisma/prisma/schema.prisma` | 删除 2 model + 关联 | L265-295, L212-213 User 关联 |
| `apps/api/src/modules/auth/service.ts` | 删除函数 | L445-534: 4 个函数 + 2 个常量 |
| `apps/api/src/modules/auth/email.service.ts` | 整文件删除 | 27 行 |
| `apps/api/src/modules/auth/__tests__/email.service.test.ts` | 整文件删除 | |
| `apps/api/src/modules/auth/routes.ts` | 删除端点 | L237-340: 4 个端点 + import + register 中的调用 |
| `apps/api/src/modules/auth/__tests__/service.test.ts` | 删除测试用例 | passwordResetToken 相关 |
| `apps/api/src/modules/auth/__tests__/routes.test.ts` | 删除测试用例 | email verification 相关 |
| `apps/web/src/pages/ResetPasswordPage.tsx` | 整文件删除 | |
| `apps/web/src/App.tsx` | 删除路由 | reset-password 路由 |
| `apps/web/src/components/AuthModal.tsx` | 删除代码 | 忘记密码链接 |

### AC-4: SpecChangeRequest

| 文件路径 | 改动类型 | 说明 |
|---------|---------|------|
| `packages/studio-prisma/prisma/schema.prisma` | 删除 model | L555-573 |
| `packages/studio-spec/src/services/change-approver.service.ts` | 整文件删除 | 328 行 |
| `packages/studio-spec/src/services/change-approver.service.test.ts` | 整文件删除 | |
| `packages/studio-spec/src/index.ts` | 删除 export | L7: ChangeApproverService, L40-42: SubmitChangeInput/Result/ApproveChangeInput type export。**保留** L39: ChangeRecord（gate-checker + change-history 使用） |
| `packages/studio-prisma/src/index.ts` | 删除条目 | L25: `SpecChangeRequest: ['metadata']` |
| `packages/studio-spec/src/services/gate-checker.service.ts` | 删除 import + 改调用 | L24: 删 import changeApproverService, L58: 改为 changeHistoryService.get() |
| `packages/studio-spec/src/services/gate-checker.service.test.ts` | 删除 mock + 改调用 | L15: 删 specChangeRequest mock, L37: 删 import changeApproverService, L107,147,172,194,220: 改为直接构造 ChangeRecord |
| `apps/api/src/modules/specs/routes.ts` | 删除 import + 删 4 端点 | L7,11: 删 ChangeApproverService import, L62-93/99-130/136-155/161-176: 删 submit-change/approve/apply/get-change 端点 |

### AC-5: CapabilityReview

| 文件路径 | 改动类型 | 说明 |
|---------|---------|------|
| `packages/studio-prisma/prisma/schema.prisma` | 删除 model + 关联 | L93-104, L85 Capability.reviews |
| `packages/studio-capability/src/services/capability.service.ts` | 删除方法+import | L8 import, L408-499 三个方法, L518 getMarketStats 调整 |

### AC-6: Company

| 文件路径 | 改动类型 | 说明 |
|---------|---------|------|
| `packages/studio-prisma/prisma/schema.prisma` | 删除 model + FK + 约束 | L106-115 Company, L39/57 AuditLog, L119/129/132/133 OKR, L402/421/424/425 Project, L435/459/463/466 Document |
| `apps/api/src/modules/companies/routes.ts` | 整文件删除 | 186 行 |
| `apps/api/src/route-registry.ts` | 删除引用 | L49,207 |
| `apps/api/src/modules/pmo/okr.service.ts` | 删除 companyId | 参数+查询过滤 |
| `apps/api/src/modules/pmo/project.service.ts` | 删除 companyId | 参数+查询过滤 |
| `apps/api/src/modules/pmo/routes.ts` | 删除 companyId | 查询参数 |
| `apps/api/src/modules/knowledge/routes.ts` | 删除 companyId | L57,61,79-89,133-147,172,471-482,723-724 |
| `apps/api/src/modules/knowledge/pattern-miner.ts` | 删除硬编码 | L299: `companyId: 'system'` |
| `packages/studio-audit/src/services/audit-service.ts` | 删除 companyId | 字段写入 |
| `apps/web/src/hooks/useCompanyId.ts` | 整文件删除 | 51 行，死代码无 importer |
| `apps/web/src/api/index.ts` | 删除 companyId | L283,295,306-307 |
| `apps/web/src/types.ts` | 删除 companyId | L120,137 类型定义 |
| `apps/web/src/pages/PMOPage.tsx` | 删除 companyId | L117,120,169,175,185,188,259,266 prop + localStorage |
| `apps/web/src/pages/Settings.tsx` | 删除 companyId | L320,327,346,355,623,639-640 公司设置 UI + localStorage |
| `apps/web/src/pages/KnowledgeImportPage.tsx` | 删除 companyId | L84-85,415-416 localStorage + API |
| `apps/web/src/components/PMOCard.tsx` | 删除 companyId | L16,19,25,33-34 prop + API |
| `apps/web/src/pages/AuditLogsPage.tsx` | 删除 companyId | L15 prop |
| `apps/web/src/App.tsx` | 删除路由 | 公司相关路由（如有） |

### AC-7: Migration

| 文件路径 | 改动类型 | 说明 |
|---------|---------|------|
| `packages/studio-prisma/prisma/migrations/` | 新增 migration | `remove-dead-tables` |

---

## 接口变更

### 删除的函数/方法

| 函数 | 文件 | AC |
|------|------|-----|
| `getOrCreateOAuthUser()` | oauth.service.ts | AC-2 |
| `createOAuthSession()` | oauth.service.ts | AC-2 |
| `exchangeCodeForTokens()` | oauth.service.ts | AC-2 |
| `getAuthorizationUrl()` | oauth.service.ts | AC-2 |
| `generateResetToken()` | auth/service.ts | AC-3 |
| `resetPassword()` | auth/service.ts | AC-3 |
| `generateEmailVerificationToken()` | auth/service.ts | AC-3 |
| `verifyEmail()` | auth/service.ts | AC-3 |
| `sendPasswordResetEmail()` | email.service.ts | AC-3 |
| `ChangeApproverService.submit()` | change-approver.service.ts | AC-4 |
| `ChangeApproverService.approve()` | change-approver.service.ts | AC-4 |
| `ChangeApproverService.apply()` | change-approver.service.ts | AC-4 |
| `ChangeApproverService.get()` | change-approver.service.ts | AC-4 |
| `ChangeApproverService.list()` | change-approver.service.ts | AC-4 |
| `CapabilityService.rate()` | capability.service.ts | AC-5 |
| `CapabilityService.updateRating()` | capability.service.ts | AC-5 |
| `CapabilityService.getReviews()` | capability.service.ts | AC-5 |

### 删除的 API 端点

| 端点 | 方法 | AC |
|------|------|-----|
| `/api/v1/auth/:provider(google\|github)` | GET | AC-2 |
| `/api/v1/auth/callback/:provider(google\|github)` | GET | AC-2 |
| `/api/v1/auth/forgot-password` | POST | AC-3 |
| `/api/v1/auth/reset-password` | POST | AC-3 |
| `/api/v1/auth/send-verification` | POST | AC-3 |
| `/api/v1/auth/verify-email` | POST | AC-3 |
| `/api/v1/companies` | GET/POST | AC-6 |
| `/api/v1/companies/:companyId` | GET/PATCH | AC-6 |
| `/api/v1/companies/sizes/config` | GET | AC-6 |
| `/api/v1/companies/:companyId/hall-stats` | GET | AC-6 |
| `/api/v1/specs/:id/submit-change` | POST | AC-4 |
| `/api/v1/specs/changes/:changeId/approve` | POST | AC-4 |
| `/api/v1/specs/changes/:changeId/apply` | POST | AC-4 |

### 保留的 API 端点（AC-4 范围内）

| 端点 | 方法 | 保留理由 |
|------|------|---------|
| `/api/v1/specs/:id/analyze-change` | POST | 用 changeAnalyzerService（不依赖 DB） |
| `/api/v1/specs/changes/:changeId/validate` | POST | 用 gateCheckerService（不依赖 DB） |
| `/api/v1/specs/gates/:level` | GET | 用 gateCheckerService |
| `/api/v1/specs/gates` | GET | 用 gateCheckerService |
| `/api/v1/specs/:id/changes` | GET | 用 changeHistoryService（内存存储） |
| `/api/v1/specs/:id/changes/stats` | GET | 用 changeHistoryService |
| `/api/v1/specs/:id/changes/export` | GET | 用 changeHistoryService |
| `/api/v1/specs/:id/changes/import` | POST | 用 changeHistoryService |
| `GET /api/v1/specs/changes/:changeId` | GET | 改为从 changeHistoryService.get() 获取 |

### 删除的导出（index.ts）

| 导出 | 文件 | AC | 说明 |
|------|------|-----|------|
| `ChangeApproverService`, `changeApproverService` | studio-spec/src/index.ts | AC-4 | 服务删除 |
| `SubmitChangeInput`, `SubmitChangeResult`, `ApproveChangeInput` | studio-spec/src/index.ts | AC-4 | 仅 change-approver 使用 |
| `useCompanyId`, `getCompanyId`, `setCompanyId` | useCompanyId.ts | AC-6 | 死代码 |

### 保留的导出（index.ts）

| 导出 | 文件 | 保留理由 |
|------|------|---------|
| `ChangeRecord` | studio-spec/src/index.ts | gate-checker.service.ts + change-history.service.ts 使用 |
| `ChangeLevel`, `ChangeType` | studio-spec/src/index.ts | change-analyzer + gate-checker 使用 |
| `ChangeAnalyzerService`, `changeAnalyzerService` | studio-spec/src/index.ts | 不依赖 DB |
| `GateCheckerService`, `gateCheckerService` | studio-spec/src/index.ts | 不依赖 DB |
| `ChangeHistoryService`, `changeHistoryService` | studio-spec/src/index.ts | 内存存储，不依赖 DB |

### Schema 变更摘要

```
删除 7 model: SignedDocument, OAuthAccount, PasswordResetToken, EmailVerificationToken, SpecChangeRequest, CapabilityReview, Company
删除 User 关联: oauthAccounts, passwordResetTokens, emailVerificationTokens
删除 Capability 关联: CapabilityReview
修改 Project: 删 companyId + Company relation, @@unique([pmoNumber])
修改 OKR: 删 companyId + Company relation, @@unique([quarter])
修改 Document: 删 companyId + Company relation
修改 AuditLog: 删 companyId
```

---

## 代码依赖图

```
schema.prisma (中心，所有 AC 都修改)
  ├── AC-1: SignedDocument
  │     └── auth.ts (findResourceCreator switch)
  │     └── studio-prisma/index.ts (JSON_FIELDS)
  │
  ├── AC-2: OAuthAccount
  │     └── oauth.service.ts ──> oauth.routes.ts ──> route-registry.ts
  │     └── User model (oauthAccounts relation)
  │     └── 前端: OAuthCallback.tsx, App.tsx, AuthModal.tsx
  │
  ├── AC-3: PasswordResetToken + EmailVerificationToken
  │     └── service.ts (4 functions) ──> routes.ts (4 endpoints)
  │     └── email.service.ts ──> routes.ts (import)
  │     └── User model (2 relations)
  │     └── 前端: ResetPasswordPage.tsx, App.tsx, AuthModal.tsx
  │
  ├── AC-4: SpecChangeRequest
  │     └── change-approver.service.ts ──> studio-spec/index.ts
  │     └── gate-checker.service.test.ts (mock)
  │     └── studio-prisma/index.ts (JSON_FIELDS)
  │
  ├── AC-5: CapabilityReview
  │     └── capability.service.ts (3 methods + import)
  │     └── Capability model (CapabilityReview relation)
  │
  ├── AC-6: Company (最广)
  │     ├── companies/routes.ts ──> route-registry.ts
  │     ├── pmo/okr.service.ts (companyId)
  │     ├── pmo/project.service.ts (companyId)
  │     ├── pmo/routes.ts (companyId)
  │     ├── knowledge/routes.ts (companyId, ~10 处)
  │     ├── knowledge/pattern-miner.ts (companyId)
  │     ├── studio-audit/audit-service.ts (companyId)
  │     ├── 前端: useCompanyId.ts, PMOPage.tsx, Settings.tsx, api/index.ts, App.tsx
  │     └── 4 个 model FK: Project, OKR, Document, AuditLog
  │
  └── AC-7: Migration (依赖 AC-1~6 全部完成)
```

---

## 模块边界

| 模块 | AC | 边界约束 |
|------|-----|---------|
| middleware/auth.ts | AC-1 | 仅删 signedDocument case，保留 document case |
| auth module | AC-2, AC-3 | 保留 register/login/logout/refresh/me/cleanup 端点 |
| studio-spec | AC-4 | 保留 ChangeAnalyzerService, GateCheckerService, SpecValidatorService |
| studio-capability | AC-5 | 保留 Capability CRUD，仅删 review 相关 |
| pmo module | AC-6 | 保留 OKR/Project 查询逻辑，仅删 companyId 维度 |
| knowledge module | AC-6 | 保留文档/知识查询逻辑，仅删 companyId 过滤 |
| studio-audit | AC-6 | 保留审计日志写入，仅删 companyId 字段 |
| 前端 | AC-2,3,6 | 保留邮箱密码登录、PMO 核心功能 |

---

## 并行/串行分析

```
AC-1 (auth.ts) ─────────────────────────┐
AC-4 (studio-spec) ──────────────────────┤
AC-5 (studio-capability) ────────────────┤
AC-2 (auth: oauth) ──────────────────────┤──> AC-7 (migration)
AC-3 (auth: password/email) ─────────────┤
AC-6 (company, cross-module) ────────────┘
```

AC-1~AC-6 代码改动在不同模块，无文件重叠（除 schema.prisma）。但 schema.prisma 是单文件，所有 AC 修改同一文件 -> schema 变更需串行（或最后批量合并）。

策略：每个 AC 独立完成代码改动 + schema 改动，AC-7 最后统一生成 migration。
