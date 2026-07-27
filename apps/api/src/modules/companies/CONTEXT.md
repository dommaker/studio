# companies

> 此文件描述 apps/api/src/modules/companies 目录的职责和上下文

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
- `hall-stats` 聚合 `~/.studio/logs/executions.jsonl` 的执行统计，文件不存在时按 0 处理。
