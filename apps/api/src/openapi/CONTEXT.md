# openapi

## 职责

OpenAPI 文档派生与 /api/docs 挂载（Phase 4 复活 Phase 0 删掉的死链）：从 route-registry 路由表 + defineRoute meta 发现端点，schema 经本目录 convert.ts 的 zodToOpenAPISchema 转换，产出 OpenAPI 3.0.3 JSON（GET /api/docs）+ Swagger UI CDN 静态页（GET /api/docs/ui）。

## 核心导出

- `convert.ts`：`zodToOpenAPISchema` + `OpenAPISchema` —— zod → OpenAPI 3.0 SchemaObject 轻量转换器（覆盖仓内所用 zod 子集；#685 自 studio-contract 搬入，唯一消费方在本目录，contract 回归纯 schema 正本）

- `discover.ts`：`discoverRoutes(table)` —— 走 Express Router 栈还原「方法+完整路径+defineRoute schema+鉴权姿态」；只收带 ROUTE_SCHEMA_META 的 defineRoute 路由，原始 handler（协议面/SSE/文件流）入 skipped；嵌套挂载：根挂载探测 matcher，静态路径挂载查 NESTED_MOUNT_HINTS 签名表（Express 5.2 layer 不留挂载路径字符串）
- `build.ts`：`buildOpenApiDocument(routes, skipped)` —— 装配文档：params/query 参数、requestBody、成功响应（response-map 命中用 contract schema，未命中退化通用 { data } 壳如实标注）、400/401/403/500 错误壳、bearerAuth security、x-studio-undocumented
- `response-map.ts`：端点 → contract xxxResponseSchema 装订表（响应 schema 正本在 contract，本表只做映射）；扩覆盖只动本表
- `index.ts`：`mountApiDocs(app, table)` —— GET /api/docs（JSON，首请求构建并缓存）+ GET /api/docs/ui（Swagger UI CDN 页）

## 注意事项

- 文档是 contract 的派生物不是正本：请求 schema 直接来自 defineRoute 实际挂载（零漂移）；响应 schema 靠 response-map 装订，防漂移靠 __tests__/openapi.probe.ts 断言「映射键 ⊆ 实际端点」。
- Phase 4 孤儿端点收缩（2026-10-17 起）逐批同步删本表映射：批1 knowledge-service 域 19→3 行（保留 entries/promote/demote）；批2 knowledge 域 8 条（顺带修正 /gaps/:type 原误挂概览响应壳的既有错误）；批3 skills 域 20→3 条（保留列表/manifest/retract-decide）；批4 evolution 5 条 + iron-laws 4 条（两域映射清零，规模兜底断言 >200 降 >150）；批5 triggers 6 条 + agent-instances 4 条 + token-usage 1 条（保留 costs/fire/terminate）；批6 audit-logs 2 条 + admin docs-freshness 1 条 + workspaces 2 条 + events agent-events 1 条（admin 域映射清零）。
- 协议面不进文档（discord/deploy webhook、SSE、MCP 消息面、health 运维探针）——它们不是 defineRoute 路由，自然落 skipped。例外清单唯一正本 = route-registry.ts `PROTOCOL_SURFACE_EXCEPTIONS`（#664 固化）：probe 断言「skipped 集合 ≡ 例外清单」双向精确相等，清单外新 raw 路由 = 红，例外被收编后不同步删清单条目 = 红。
- 鉴权语义来自 route-registry 的 describeEntryAuth（姿态数组模块级共享，按数组引用判别）。
