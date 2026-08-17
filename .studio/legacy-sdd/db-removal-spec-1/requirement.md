---
slug: db-removal-spec-1
title: DB 移除 Spec 1 - 死代码表清理
status: draft
createdAt: 2026-07-15
type: migration
source: docs/specs/db-removal/spec-1-dead-code-cleanup.md
---

## 需求概述

删除 7 个死代码/重叠 Prisma 表，清理所有后端+前端引用。DB 移除工程第一步，风险最低。

7 表分布：SignedDocument（未使用）、OAuthAccount（本地不需要）、PasswordResetToken + EmailVerificationToken（本地不需要）、SpecChangeRequest（与 SpecReview 重叠）、CapabilityReview（与知识库重叠）、Company（多租户遗留）。

相关 spec: `docs/specs/db-removal/spec-1-dead-code-cleanup.md`

---

## 源项目清单

| # | 源项目 | 产出类型 | SDD AC |
|---|--------|---------|--------|
| S1 | SignedDocument 表 + auth.ts 引用删除 | 代码删除 | AC-1 |
| S2 | OAuthAccount 表 + oauth 服务/路由/前端删除 | 代码删除 | AC-2 |
| S3 | PasswordResetToken 表 + 服务/路由/前端删除 | 代码删除 | AC-3 |
| S4 | EmailVerificationToken 表 + 服务/路由删除 | 代码删除 | AC-3 |
| S5 | SpecChangeRequest 表 + change-approver 服务删除 | 代码删除 | AC-4 |
| S6 | CapabilityReview 表 + capability service 方法删除 | 代码删除 | AC-5 |
| S7 | Company 表 + 外键 + 路由 + 前端删除 | 代码删除 + Schema 变更 | AC-6 |
| S8 | Prisma migration 生成 | Schema 迁移 | AC-7 |

排除决策：无排除项。全部 8 个源项目纳入本次 SDD。

---

## AC-1: SignedDocument 表删除

`covers: [S1]`

SignedDocument 全仓库仅 1 处引用（auth middleware 所有权检查 switch case），功能未实际使用。

### AC-1.1: Schema 删除

- **触发**：`prisma validate` 通过
- **预期**：`schema.prisma` 删除 `model SignedDocument`（L171-194）
- **不做**：不处理 Document model（Spec 3 处理）

### AC-1.2: 后端引用清理

- **触发**：`tsc --noEmit` 无类型错误
- **预期**：
  1. `apps/api/src/middleware/auth.ts:250-253` 删除 `case 'signedDocument'` 分支
  2. `packages/studio-prisma/src/index.ts:20` 删除 `SignedDocument: ['metadata', 'approvals']` JSON_FIELDS 条目
- **边界**：`findResourceCreator` 的 `case 'document'` 保留（Document 表在 Spec 3 删除）

### AC-1.3: 残留验证

- **触发**：`grep -r "signedDocument\|SignedDocument" --include="*.ts"` 无残留（排除 migration 历史、node_modules）
- **预期**：0 结果

---

## AC-2: OAuthAccount 表删除

`covers: [S2]`

本地模式不需要 OAuth；线上模式用 users.json 替代（Spec 4 实现）。当前 OAuth 服务+路由+前端全部删除。

### AC-2.1: Schema 删除

- **预期**：
  1. `schema.prisma` 删除 `model OAuthAccount`（L247-263）
  2. `schema.prisma` User model 删除 `oauthAccounts OAuthAccount[]`（L210）

### AC-2.2: 后端服务+路由删除

- **预期**：
  1. `apps/api/src/modules/auth/oauth.service.ts` 整文件删除
  2. `apps/api/src/modules/auth/oauth.routes.ts` 整文件删除
  3. `apps/api/src/route-registry.ts:39` 删除 `oauthRoutes` 解构
  4. `apps/api/src/route-registry.ts:59` 删除 oauth.routes 动态 import
  5. `apps/api/src/route-registry.ts:170` 删除 `{ path: '/api/v1/auth', router: oauthRoutes }` 挂载
  6. `apps/api/src/modules/auth/__tests__/oauth.service.test.ts` 整文件删除
  7. `apps/api/src/modules/auth/__tests__/oauth.routes.test.ts` 整文件删除

### AC-2.3: 前端清理

- **预期**：
  1. `apps/web/src/components/OAuthCallback.tsx` 整文件删除
  2. `apps/web/src/components/__tests__/OAuthCallback.test.tsx` 整文件删除
  3. `apps/web/src/App.tsx` 移除 OAuth callback 路由
  4. `apps/web/src/components/AuthModal.tsx` 移除 OAuth 登录按钮（Google/GitHub）
- **边界**：AuthModal 的邮箱/密码登录保留

### AC-2.4: 残留验证

- `grep -r "OAuthAccount\|oauthAccount\|oauth\.service\|oauth\.routes\|OAuthCallback" --include="*.ts" --include="*.tsx"` 无残留（排除 migration 历史、node_modules）

---

## AC-3: PasswordResetToken + EmailVerificationToken 表删除

`covers: [S3, S4]`

本地不需要密码重置和邮箱验证；线上可后续按需加。两个功能紧密关联，合并为一个 AC。

### AC-3.1: Schema 删除

- **预期**：
  1. `schema.prisma` 删除 `model PasswordResetToken`（L265-279）
  2. `schema.prisma` 删除 `model EmailVerificationToken`（L281-~295）
  3. User model 删除 `passwordResetTokens PasswordResetToken[]`（L212）
  4. User model 删除 `emailVerificationTokens EmailVerificationToken[]`（L213）

### AC-3.2: 后端服务函数删除

- **预期**：
  1. `apps/api/src/modules/auth/service.ts` 删除 `generateResetToken()`（L445-460）
  2. `apps/api/src/modules/auth/service.ts` 删除 `resetPassword()`（L465-489）
  3. `apps/api/src/modules/auth/service.ts` 删除 `generateEmailVerificationToken()`（L497-510）
  4. `apps/api/src/modules/auth/service.ts` 删除 `verifyEmail()`（L515-534）
  5. `apps/api/src/modules/auth/service.ts` 删除 `RESET_TOKEN_EXPIRY_HOURS` 和 `EMAIL_VERIFICATION_EXPIRY_HOURS` 常量
  6. `apps/api/src/modules/auth/email.service.ts` 整文件删除（仅服务密码重置邮件）
  7. `apps/api/src/modules/auth/__tests__/email.service.test.ts` 整文件删除

### AC-3.3: 后端路由删除

- **预期**：
  1. `apps/api/src/modules/auth/routes.ts` 删除 `POST /forgot-password` 端点（L237-256）
  2. `apps/api/src/modules/auth/routes.ts` 删除 `POST /reset-password` 端点（L262-280）
  3. `apps/api/src/modules/auth/routes.ts` 删除 `POST /send-verification` 端点（L286-316）
  4. `apps/api/src/modules/auth/routes.ts` 删除 `POST /verify-email` 端点（L322-340）
  5. `apps/api/src/modules/auth/routes.ts` 删除 `import { sendPasswordResetEmail }` (L13)
  6. `apps/api/src/modules/auth/routes.ts` 删除 register 端点中的 `generateEmailVerificationToken` 调用（L48-54）
  7. `apps/api/src/modules/auth/__tests__/service.test.ts` 删除 passwordResetToken 相关 mock 和测试用例
  8. `apps/api/src/modules/auth/__tests__/routes.test.ts` 删除 email verification 相关 mock 和测试用例

### AC-3.4: 前端清理

- **预期**：
  1. `apps/web/src/pages/ResetPasswordPage.tsx` 整文件删除
  2. `apps/web/src/App.tsx` 移除 reset-password 路由
  3. `apps/web/src/components/AuthModal.tsx` 移除"忘记密码"链接

### AC-3.5: 残留验证

- `grep -r "passwordResetToken\|PasswordResetToken\|emailVerificationToken\|EmailVerificationToken\|resetPassword\|verifyEmail\|generateResetToken\|generateEmailVerificationToken" --include="*.ts" --include="*.tsx"` 无残留（排除 migration 历史、node_modules）

---

## AC-4: SpecChangeRequest 表删除

`covers: [S5]`

与 SpecReview + SDD 文件体系重叠。`change-approver.service.ts` 全部方法依赖 `prisma.specChangeRequest`，整体删除。`ChangeAnalyzerService` 不依赖 DB，保留。

### AC-4.1: Schema 删除

- **预期**：`schema.prisma` 删除 `model SpecChangeRequest`（L555-573）

### AC-4.2: 后端服务删除

- **预期**：
  1. `packages/studio-spec/src/services/change-approver.service.ts` 整文件删除
  2. `packages/studio-spec/src/services/change-approver.service.test.ts` 整文件删除
  3. `packages/studio-spec/src/index.ts` 删除 `export { ChangeApproverService, changeApproverService }` (L7)
  4. `packages/studio-prisma/src/index.ts:25` 删除 `SpecChangeRequest: ['metadata']` JSON_FIELDS 条目
- **边界**：
  - `ChangeAnalyzerService` 和 `changeAnalyzerService` 保留（不依赖 DB）
  - `ChangeRecord` 类型**保留**：被 `gate-checker.service.ts`（L23,130,277,304,332,378,417）和 `change-history.service.ts`（L14,24,30,46,56,71,128）使用
  - `SubmitChangeInput`, `SubmitChangeResult`, `ApproveChangeInput` 类型**删除**：仅被 change-approver.service.ts 使用
- **不做**：不处理 SpecReview 表（Spec 3 处理）、不处理 SpecBypass/SpecVersion（Spec 3 处理）

### AC-4.3: gate-checker.service.ts 依赖清理

- **预期**：
  1. `packages/studio-spec/src/services/gate-checker.service.ts:24` 删除 `import { changeApproverService } from './change-approver.service.js'`
  2. `packages/studio-spec/src/services/gate-checker.service.ts:58` 删除 `const change = await changeApproverService.get(changeId)` 调用，改为从 `changeHistoryService.get(changeId)` 获取
  3. `packages/studio-spec/src/services/gate-checker.service.test.ts:37` 删除 `import { changeApproverService }` (L37)
  4. `packages/studio-spec/src/services/gate-checker.service.test.ts:107,147,172,194,220` 删除 `changeApproverService.submit()` 调用，改为直接构造 ChangeRecord 通过 `changeHistoryService.save()` 注入
  5. `packages/studio-spec/src/services/gate-checker.service.test.ts:15` 删除 `specChangeRequest` mock 引用

### AC-4.4: specs/routes.ts 端点清理

- **预期**：
  1. `apps/api/src/modules/specs/routes.ts:7,11` 删除 `ChangeApproverService`, `changeApproverService` import
  2. 删除 4 个依赖 changeApproverService 的端点：
     - `POST /:id/submit-change`（L62-93）
     - `POST /changes/:changeId/approve`（L99-130）
     - `POST /changes/:changeId/apply`（L136-155）
     - `GET /changes/:changeId`（L161-176）改为从 `changeHistoryService.get()` 获取
  3. 保留端点：`POST /:id/analyze-change`（用 changeAnalyzerService）、`POST /changes/:changeId/validate` + `GET /gates/:level` + `GET /gates`（用 gateCheckerService）、`GET /:id/changes` + `GET /:id/changes/stats` + `GET /:id/changes/export` + `POST /:id/changes/import`（用 changeHistoryService）

### AC-4.5: 残留验证

- `grep -r "specChangeRequest\|SpecChangeRequest\|ChangeApproverService\|changeApproverService" --include="*.ts"` 无残留（排除 migration 历史、node_modules）

---

## AC-5: CapabilityReview 表删除

`covers: [S6]`

与 `~/.studio/knowledge/` 知识审核重叠。删除表 + capability service 中的 review 相关方法。

### AC-5.1: Schema 删除

- **预期**：
  1. `schema.prisma` 删除 `model CapabilityReview`（L93-104）
  2. `schema.prisma` Capability model 删除 `CapabilityReview CapabilityReview[]`（L85）

### AC-5.2: 后端服务清理

- **预期**：
  1. `packages/studio-capability/src/services/capability.service.ts:8` 删除 `CapabilityReview` import
  2. 删除 `rate()` 方法（L408-455）
  3. 删除 `updateRating()` 方法（L460-477）
  4. 删除 `getReviews()` 方法（L482-499）
  5. `getMarketStats()` 方法（L504-529）删除 `capabilityReview.findMany()` 调用，`totalReviews` 改为 0 或移除
- **边界**：Capability CRUD 保留（Spec 2b 迁移到文件）
- **不做**：不删除 capability.service.ts（其他方法保留）

### AC-5.3: 残留验证

- `grep -r "capabilityReview\|CapabilityReview" --include="*.ts"` 无残留（排除 migration 历史、node_modules）

---

## AC-6: Company 表删除

`covers: [S7]`

多租户遗留。本地单租户隐式。删除 Company model + 4 个引用模型的 companyId 字段 + 唯一约束变更 + 路由删除 + 前端清理。

### AC-6.1: Schema 变更

- **预期**：
  1. `schema.prisma` 删除 `model Company`（L106-115）
  2. Project model：删除 `companyId String`（L402）、删除 `Company Company @relation(...)` （L421）、`@@unique([companyId, pmoNumber])` 改为 `@@unique([pmoNumber])`（L424）、删除 `@@index([companyId])`（L425）
  3. OKR model：删除 `companyId String`（L119）、删除 `Company Company @relation(...)`（L129）、`@@unique([companyId, quarter])` 改为 `@@unique([quarter])`（L132）、删除 `@@index([companyId])`（L133）
  4. Document model：删除 `companyId String`（L435）、删除 `Company Company @relation(...)`（L459）、删除 `@@index([companyId])`（L463）、删除 `@@index([companyId, status, type])`（L466）
  5. AuditLog model：删除 `companyId String?`（L39）、删除 `@@index([companyId])`（L57）

### AC-6.2: 后端路由删除

- **预期**：
  1. `apps/api/src/modules/companies/routes.ts` 整文件删除
  2. `apps/api/src/route-registry.ts:49` 删除 companies 动态 import
  3. `apps/api/src/route-registry.ts:207` 删除 `{ path: '/api/v1/companies', router: companyRoutes }` 挂载

### AC-6.3: 后端 service/route companyId 引用清理

- **预期**：
  1. `apps/api/src/modules/pmo/okr.service.ts` 移除所有 companyId 参数和查询过滤
  2. `apps/api/src/modules/pmo/project.service.ts` 移除 companyId 参数和查询过滤
  3. `apps/api/src/modules/pmo/routes.ts` 移除 companyId 查询参数
  4. `apps/api/src/modules/knowledge/routes.ts` 移除 companyId 查询/过滤（L57,61,79-89,133-147,172,471-482,723-724）
  5. `apps/api/src/modules/knowledge/pattern-miner.ts:299` 移除 `companyId: 'system'` 硬编码
  6. `packages/studio-audit/src/services/audit-service.ts` 移除 companyId 字段写入
- **边界**：不删除 OKR/Project/AuditLog 表（Spec 2b 迁移）
- **不做**：不重构 OKR/Project 的存储方式（仅移除 companyId）

### AC-6.4: 前端清理

注意：`useCompanyId` hook 无任何文件 import（已死代码）。companyId 通过 `localStorage.getItem('companyId')` 直接使用。

- **预期**：
  1. `apps/web/src/hooks/useCompanyId.ts` 整文件删除（死代码，无 importer）
  2. `apps/web/src/api/index.ts` 移除 companyId 相关 API 调用（L283,295,306-307）
  3. `apps/web/src/types.ts` 移除 companyId 字段（L120,137）
  4. `apps/web/src/pages/PMOPage.tsx` 移除 companyId prop 和 `localStorage.getItem('companyId')` 调用（L117,120,169,175,185,188,259,266）
  5. `apps/web/src/pages/Settings.tsx` 移除公司设置 UI 和 `localStorage` companyId 操作（L320,327,346,355,623,639-640）
  6. `apps/web/src/pages/KnowledgeImportPage.tsx` 移除 companyId localStorage 和 API 调用（L84-85,415-416）
  7. `apps/web/src/components/PMOCard.tsx` 移除 companyId prop 和 API 调用（L16,19,25,33-34）
  8. `apps/web/src/pages/AuditLogsPage.tsx` 移除 companyId prop（L15）
  9. `apps/web/src/App.tsx` 移除公司相关路由（如有）
- **边界**：PMO 页面核心功能（项目列表、OKR 查看）保留，仅移除 companyId 维度

### AC-6.5: 残留验证

- `grep -r "companyId\|Company" --include="*.ts" --include="*.tsx"` 无残留（排除 migration 历史、node_modules、e2e 测试中的测试数据）

---

## AC-7: Prisma migration 生成

`covers: [S8]`

### AC-7.1: Migration 生成

- **预期**：
  1. 运行 `npx prisma migrate dev --name remove-dead-tables`
  2. `npx prisma validate` 通过
  3. `npx tsc --noEmit` 无类型错误
  4. 全量测试通过

### AC-7.2: Prisma client 重新生成

- **预期**：`npx prisma generate` 后 `@prisma/client` 不再包含 7 个删除的 model 类型

---

## 不做项

- 不迁移数据（死代码表无数据需迁移，Company 数据在迁移脚本中清空）
- 不做 API 向后兼容（端点直接删除）
- 不处理 Document 表（Spec 3）
- 不处理 SpecReview/SpecBypass/SpecVersion（Spec 3）
- 不重构 OKR/Project 存储方式（Spec 2b）
- 不处理线上 dommaker.cn 迁移（部署阶段处理）
