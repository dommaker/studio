# companies

> 此文件描述 apps/api/src/modules/companies 目录的职责和上下文

<!-- STALE_SINCE: 2026-08-03 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/companies/CONTEXT.md, apps/api/src/modules/companies/routes.ts

## 职责

公司（Company）记录的 CRUD REST API，FileStore 文件存储（`~/.studio/data/companies/*.json`），不依赖数据库。前端 PMO 页、Settings 页、`useCompanyId` hook 依赖本模块获取/创建默认公司，PMO 的 OKR/项目均以 companyId 作为归属维度。创建公司时会自动调用 `okrService.createDefaultOKR` 生成默认 OKR。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `default router` | `routes.ts` | Express 路由器：`GET /` 列表、`POST /` 创建、`GET /:companyId` 详情、`PATCH /:companyId` 更新、`GET /sizes/config` 规模配置、`GET /:companyId/hall-stats` 大厅统计 |

## 依赖关系

**上游**:
- `@dommaker/studio-shared`（FileStore）
- `../../utils/logger`（日志）
- `../pmo/okr.service`（创建公司时自动生成默认 OKR，动态导入）

**下游**:
- `apps/api/src/route-registry.ts`：挂载于 `/api/v1/companies`（middleware: auth）。

## 注意事项

- 本模块在 008912d（db-removal）中被误删，导致前端 `/api/v1/companies` 404，后按 FileStore 版本恢复；与 Prisma 无任何关联。
- `GET /sizes/config` 必须在 `GET /:companyId` 之后不会冲突：`/:companyId` 只匹配单段路径。
- `hall-stats` 聚合 `~/.studio/logs/executions.jsonl` 的执行统计（测试环境隔离到 os.tmpdir()/studio-test-logs，见 utils/studio-log-path.ts），文件不存在时按 0 处理。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `6f263685`: p0): 信任链六项修复 — 失败误判/超时机制/reviewReport回传/告警出口/日志隔离/traceId
- ✅ `5e67bf92`: companies 模块恢复（008912d 误删后 FileStore 重建）
- ✅ `008912d6`: db-removal): complete Spec 1 AC-2/3/6 — dead table cleanup
- ✅ `1773bfdf`: db-removal): migrate 11 files from Prisma → FileStore (59 calls eliminated)
- ✅ `b85449b1`: db-removal): final sweep — 全仓库 prisma 引用清零
