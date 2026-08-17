---
id: "cmqiwz8mp015dmekjsh6nbhi5"
slug: "fix-docs-freshness-api-capability-sync"
title: "修复 docs-freshness API capability_sync 过滤器不匹配"
status: "done"
tier: "fast"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
sourceChannelId: "cmqgvblj6000mhqtioulyu771"
tags: ["bug", "docs-freshness", "capability-sync", "harness", "trigger-mismatch"]
createdAt: "2026-06-18T03:02:14.393Z"
updatedAt: "2026-06-18T03:02:14.393Z"
---

## 修复 docs-freshness API capability_sync 过滤器不匹配

docs-freshness 端点调用 checkConstraints({ operation: 'file_modification' }) 过滤 capability_sync 和 docs_freshness 约束，但 capability_sync 的 trigger 数组不包含 file_modification，导致 matchesTrigger() 始终跳过该约束。修复：将 operation 改为 module_modification，使两个约束的 trigger 交集匹配。

## AC Groups

### AC-1

#### 验收标准
- [ ] 将 checkConstraints 调用参数从 operation:'file_modification' 改为 operation:'module_modification'
- [ ] 验证修改后 docs_freshness 约束仍被命中（trigger 数组包含 module_modification）
- [ ] 验证修改后 capability_sync 约束被命中（trigger 数组包含 module_modification）

#### 涉及文件
- apps/api/src/modules/admin/docs-freshness.routes.ts

#### 依赖

### AC-2

#### 验收标准
- [ ] 新增或更新测试：mock checkConstraints 返回包含 capability_sync 的 guidelines 数组
- [ ] 断言 GET / 响应的 harnessCheck.details 数组中包含 id 为 capability_sync 的条目
- [ ] 断言 harnessCheck.details 中 capability_sync 条目的 passed 字段反映 mock 结果

#### 涉及文件
- apps/api/src/modules/admin/__tests__/docs-freshness.routes.test.ts

#### 依赖: AC-1

### AC-3

#### 验收标准
- [ ] 运行 tsc --noEmit 确认 TypeScript 编译通过
- [ ] 运行 pnpm test 确认所有现有测试不被破坏
- [ ] 运行新测试确认 capability_sync 断言通过

#### 涉及文件
- apps/api/src/modules/admin/docs-freshness.routes.ts
- apps/api/src/modules/admin/__tests__/docs-freshness.routes.test.ts

#### 依赖: AC-1, AC-2


## Files

- apps/api/src/modules/admin/docs-freshness.routes.ts
- apps/api/src/modules/admin/__tests__/docs-freshness.routes.test.ts