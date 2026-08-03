# wiki

> 此文件描述 apps/api/src/modules/wiki 目录的职责和上下文

<!-- STALE_SINCE: 2026-08-03 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/wiki/CONTEXT.md, apps/api/src/modules/wiki/wiki.routes.ts, apps/api/src/modules/wiki/wiki.service.ts

## 职责

本目录实现 Wiki 文档的查询与更新 API，基于 SDD（Software Design Document）文件读取，提供列表搜索、图谱构建、文档详情与内容更新功能。所有读取操作均为 SDD-only（不依赖数据库），符合 B2-008 规范。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `wikiRoutes` | `wiki.routes.ts` | Express 路由，注册 `/api/v1/wiki` 下的 GET 列表、GET /graph、GET /:id 详情、PUT /:id 更新端点 |
| `listWikiDocs` | `wiki.service.ts` | 过滤搜索 Wiki 文档（支持 search/status），返回 `WikiListItem[]` |
| `buildWikiGraph` | `wiki.service.ts` | 构建所有文档的节点与边图结构，返回 `{ nodes, edges }` |
| `getWikiDocById` | `wiki.service.ts` | 获取单个文档详情（含内容、链接解析、三级层级），返回 `WikiDocDetail` |

## 依赖关系

上游：
- `@dommaker/studio-shared`（依赖 `listSddDocs`、`readSddDoc`、`findSddDocById`、`logger`、`appendChangelog`、`updateSddFrontmatter`）
- `express`（Router）

下游：
- `apps/api/src/route-registry.ts`（引入 `wikiRoutes` 并挂载至 `/api/v1/wiki` 路径）

## 注意事项

- 所有读取操作均为 SDD-only，禁止回退到数据库读取
- PUT 更新接口必须校验 `content` 为字符串类型，避免非字符串导致写入异常
- `linkedDocIds` 参数兼容数组与 JSON 字符串形式，需使用 `parseLinkedDocIds` 解析
- 路由中每个端点包含 `try-catch` 错误处理，统一返回 500 错误
- 遵循 B2-008 规范，Wiki 文档即为 RequirementsDoc 档案馆的视图
- **鉴权（2026-07-24 收紧）**：PUT /:id 已收 requireAuth+requireNotGuest。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `782ac0a9`: 路由层防御纵深 — 写操作端点加 requireAuth+requireNotGuest/requireAdmin
- ✅ 2026-07-24: PUT /:id 收 requireAuth+requireNotGuest
- ✅ `389c9e87`: add await to all sdd-utils consumers after Phase 4 async migration
- ✅ `5b7ec85c`: web): 修复 4 个生产崩溃 + 菜单冗余整合
- ✅ `1c4ac168`: SP-004): 补齐 SDD 三个缺口 — Files section + Analyst 输出 + 去 DB 读
