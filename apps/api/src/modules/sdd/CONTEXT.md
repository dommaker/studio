# sdd

> 此文件描述 apps/api/src/modules/sdd 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/sdd/CONTEXT.md, apps/api/src/modules/sdd/sdd-freshness.service.ts

## 职责

SDD（变更规格）文档新鲜度服务：检测 `docs/sdd/` 规格文档与代码演进的漂移。

## 核心导出

- `sdd-freshness.service.ts` — SDD Doc Freshness Service

## 依赖关系

- 上游：FileStore / 文件系统（docs/sdd 规格文档）
- 下游：apps/api 内部消费（文档治理相关流程）

## 注意事项

- SDD 按变更立项，存放在 `docs/sdd/`，规范见 docs/plans 各期计划

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `389c9e87`: add await to all sdd-utils consumers after Phase 4 async migration
