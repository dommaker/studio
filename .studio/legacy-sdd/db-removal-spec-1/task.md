---
slug: db-removal-spec-1
title: DB 移除 Spec 1 - 死代码表清理 - 任务
status: draft
createdAt: 2026-07-15
type: migration
---

## 契约测试规划

### AC-1: SignedDocument

| 测试文件 | 测试用例 | 验证点 |
|---------|---------|--------|
| `apps/api/src/middleware/__tests__/auth.test.ts`（现有） | `findResourceCreator('signedDocument')` 抛出 Unsupported error | 删除后调用应抛 `Unsupported ownership model: signedDocument` |
| `npx tsc --noEmit` | 编译通过 | 无 SignedDocument 类型残留 |

### AC-2: OAuthAccount

| 测试文件 | 测试用例 | 验证点 |
|---------|---------|--------|
| `apps/api/src/modules/auth/__tests__/oauth.service.test.ts` | 文件删除 | 文件不存在 |
| `apps/api/src/modules/auth/__tests__/oauth.routes.test.ts` | 文件删除 | 文件不存在 |
| `apps/api/src/route-registry.test.ts`（如有） | /api/v1/auth/:provider 返回 404 | OAuth 路由未挂载 |
| `apps/web/src/components/__tests__/OAuthCallback.test.tsx` | 文件删除 | 文件不存在 |
| `npx tsc --noEmit` | 编译通过 | 无 OAuthAccount 类型残留 |

### AC-3: PasswordResetToken + EmailVerificationToken

| 测试文件 | 测试用例 | 验证点 |
|---------|---------|--------|
| `apps/api/src/modules/auth/__tests__/service.test.ts` | passwordResetToken mock 删除 | mock 对象无 passwordResetToken 字段 |
| `apps/api/src/modules/auth/__tests__/service.test.ts` | register 不再调用 generateEmailVerificationToken | 0 次调用 |
| `apps/api/src/modules/auth/__tests__/routes.test.ts` | /forgot-password 端点不存在 | 返回 404 |
| `apps/api/src/modules/auth/__tests__/routes.test.ts` | /reset-password 端点不存在 | 返回 404 |
| `apps/api/src/modules/auth/__tests__/routes.test.ts` | /verify-email 端点不存在 | 返回 404 |
| `apps/api/src/modules/auth/__tests__/routes.test.ts` | /send-verification 端点不存在 | 返回 404 |
| `apps/api/src/modules/auth/__tests__/email.service.test.ts` | 文件删除 | 文件不存在 |
| `npx tsc --noEmit` | 编译通过 | 无 PasswordResetToken/EmailVerificationToken 类型残留 |

### AC-4: SpecChangeRequest

| 测试文件 | 测试用例 | 验证点 |
|---------|---------|--------|
| `packages/studio-spec/src/services/change-approver.service.test.ts` | 文件删除 | 文件不存在 |
| `packages/studio-spec/src/services/gate-checker.service.test.ts` | specChangeRequest mock 删除 | mock 对象无 specChangeRequest 字段 |
| `packages/studio-spec/src/services/gate-checker.service.test.ts` | changeApproverService import 删除 | L37 无 import |
| `packages/studio-spec/src/services/gate-checker.service.test.ts` | changeApproverService.submit 调用替换 | L107,147,172,194,220 改为 changeHistoryService.save() |
| `apps/api/src/modules/specs/routes.ts` | submit-change/approve/apply 端点返回 404 | 3 个端点已删除 |
| `npx tsc --noEmit` | 编译通过 | 无 SpecChangeRequest/ChangeApproverService 类型残留 |

### AC-5: CapabilityReview

| 测试文件 | 测试用例 | 验证点 |
|---------|---------|--------|
| `packages/studio-capability/src/__tests__/imports.test.ts` | import { CapabilityReview } 抛出 | 类型不存在 |
| `packages/studio-capability/src/__tests__/capability.service.test.ts`（如有） | rate() 方法不存在 | 调用抛 TypeError |
| `npx tsc --noEmit` | 编译通过 | 无 CapabilityReview 类型残留 |

### AC-6: Company

| 测试文件 | 测试用例 | 验证点 |
|---------|---------|--------|
| `apps/api/src/modules/pmo/__tests__/okr.service.test.ts`（如有） | OKR 查询不再接受 companyId 参数 | 参数被忽略或报错 |
| `apps/api/src/modules/pmo/__tests__/project.service.test.ts`（如有） | Project 查询不再接受 companyId 参数 | 参数被忽略或报错 |
| `apps/web/src/pages/__tests__/PMOPage.test.tsx` | 无 useCompanyId 调用 | hook 不存在 |
| `apps/web/src/hooks/__tests__/useCompanyId.test.ts`（如有） | 文件删除 | 文件不存在 |
| `npx tsc --noEmit` | 编译通过 | 无 Company 类型残留 |

### AC-7: Migration

| 验证项 | 命令 | 通过标准 |
|--------|------|---------|
| Schema 合法 | `npx prisma validate` | 无错误 |
| 类型检查 | `npx tsc --noEmit` | 无错误 |
| 全量测试 | `pnpm test` | 全部通过 |
| 残留检查 | `grep -r "SignedDocument\|OAuthAccount\|PasswordResetToken\|EmailVerificationToken\|SpecChangeRequest\|CapabilityReview\|Company" --include="*.ts" --include="*.tsx"` | 0 结果（排除 migration 历史、node_modules） |

---

## 执行顺序

### Phase 1 [safe]: 独立死代码删除

**AC-1 + AC-4 + AC-5**（可并行，不同模块）

```
AC-1 (SignedDocument)     -- auth.ts 1 分支 + JSON_FIELDS 1 条
AC-4 (SpecChangeRequest)  -- studio-spec 服务删除 + export 清理
AC-5 (CapabilityReview)   -- studio-capability 方法删除
```

依赖分析：
- AC-1 改 `auth.ts` + `schema.prisma` + `studio-prisma/index.ts`
- AC-4 改 `studio-spec/` + `schema.prisma` + `studio-prisma/index.ts`
- AC-5 改 `studio-capability/` + `schema.prisma`
- 文件重叠：`schema.prisma`（不同 model，无冲突）、`studio-prisma/index.ts`（不同行，无冲突）
- 可并行执行

Checkpoint：`tsc --noEmit` 通过 + 相关模块测试通过

### Phase 2 [breaking]: Auth 功能删除

**AC-2 + AC-3**（串行，同模块文件重叠）

```
AC-2 (OAuthAccount)        -- oauth 服务/路由/前端删除
  └──> AC-3 (Password/Email)  -- service/routes 删除 + 前端删除
```

依赖分析：
- AC-2 和 AC-3 都改 `auth/routes.ts`、`auth/__tests__/`、`App.tsx`、`AuthModal.tsx`
- 必须串行，AC-2 先（oauth.service.ts 独立文件，删除影响小）
- AC-3 后（service.ts 和 routes.ts 内部删函数/端点）

Checkpoint：`tsc --noEmit` 通过 + auth 模块测试通过

### Phase 3 [breaking]: Company 跨模块删除

**AC-6**（独立 phase，跨模块影响最广）

```
AC-6 (Company)  -- schema FK + 6 个后端文件 + 9 个前端文件
```

依赖分析：
- 改动 `schema.prisma`（4 个 model FK 删除）
- 改动 `companies/routes.ts`（整文件删除）
- 改动 `pmo/`、`knowledge/`、`studio-audit/`（companyId 引用清理）
- 改动前端 `useCompanyId.ts`、`PMOPage.tsx`、`Settings.tsx`、`api/index.ts`、`App.tsx`
- 与 Phase 1/2 无文件重叠

Checkpoint：`tsc --noEmit` 通过 + pmo/knowledge/前端测试通过

### Phase 4 [safe]: Migration 生成

**AC-7**（依赖 Phase 1-3 全部完成）

```
AC-7 (Migration)  -- prisma migrate dev + validate + tsc + test
```

依赖分析：
- 依赖所有前序 AC 的 schema 变更已合入
- 生成一个 migration 文件包含全部 7 个 model 的 DROP

Checkpoint：`prisma validate` + `tsc --noEmit` + `pnpm test` 全通过

---

## 里程碑

| 里程碑 | 完成标志 | Phase |
|--------|---------|-------|
| M1: 死代码清零 | AC-1+4+5 完成，grep 零残留 | Phase 1 |
| M2: Auth 精简 | AC-2+3 完成，auth 模块测试通过 | Phase 2 |
| M3: 单租户化 | AC-6 完成，companyId 零残留 | Phase 3 |
| M4: Migration 生成 | AC-7 完成，全量测试通过 | Phase 4 |

---

## 风险标注

| Phase | 风险等级 | 风险描述 | 缓解 |
|-------|---------|---------|------|
| Phase 1 | [safe] | 删除未使用代码，影响范围小 | grep 验证零残留 |
| Phase 2 | [breaking] | OAuth/密码重置可能被 dommaker.cn 使用 | 线上先确认是否有 OAuth 用户，如有先迁移到 users.json |
| Phase 3 | [breaking] | Company FK 跨 4 个 model + 6 个后端文件 + 9 个前端文件 | 逐文件改造，每文件改完即测 |
| Phase 4 | [safe] | migration 生成是机械操作 | validate + tsc + test 三重验证 |

---

## 三层一致性检查

| AC | requirement.md | design.md 文件映射 | task.md 测试 |
|----|---------------|-------------------|-------------|
| AC-1 | SignedDocument 3 条预期 | 3 文件 | 2 测试 |
| AC-2 | OAuthAccount 4 条预期 | 10 文件 | 5 测试 |
| AC-3 | PasswordReset+EmailVerification 5 条预期 | 10 文件 | 8 测试 |
| AC-4 | SpecChangeRequest 5 条预期（含 gate-checker + specs/routes 清理） | 9 文件 | 6 测试 |
| AC-5 | CapabilityReview 3 条预期 | 2 文件 | 3 测试 |
| AC-6 | Company 5 条预期（含 9 前端文件） | 18 文件 | 5 测试 |
| AC-7 | Migration 2 条预期 | 1 目录 | 4 验证项 |

---

## Implementation Readiness

implementationReady: true

| # | 条件 | 满足 | 证据 |
|---|------|------|------|
| 1 | design.md 有精确 file:line 引用 | ✅ | 每个 AC 都有行号：AC-1 auth.ts L250-253 + schema.prisma L171-194 + studio-prisma/index.ts L20；AC-2 schema.prisma L247-263 等；AC-6 schema.prisma L106-115 等。已验证 auth.ts L250 `case 'signedDocument'` 和 schema.prisma 7 个 model 行号匹配 |
| 2 | 非平凡变更有 before/after 代码块 | ✅ | 纯删除任务：design.md 标注"整文件删除"/"删除 model L171-194"/"删除 case 分支 L250-253"。before=指定行号现有代码，after=删除。删除类改动有行号即明确 |
| 3 | 消费方覆盖（谁 import 受影响文件） | ✅ | design.md "代码依赖图"节展示每个 AC 的依赖链。AC-6 显式列出 6 后端文件 + 9 前端文件。"模块边界"节标注保留/删除边界 |
| 4 | 测试断言具体（不只是"测试通过"） | ✅ | task.md 有具体断言：AC-1 "抛 `Unsupported ownership model: signedDocument`"；AC-3 "0 次调用"+"返回 404"；AC-7 "grep 零残留" |
| 5 | 接口定义完整（签名+参数+返回值） | ✅ | design.md "接口变更"节列出 17 个删除的函数/方法 + 13 个删除的 API 端点 + 保留的端点清单 |
