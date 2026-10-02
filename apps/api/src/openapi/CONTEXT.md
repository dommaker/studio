# openapi

## 职责

OpenAPI 文档派生与 /api/docs 挂载（Phase 4 复活 Phase 0 删掉的死链）：从 route-registry 路由表 + defineRoute meta 发现端点，schema 经 contract 的 zodToOpenAPISchema 转换，产出 OpenAPI 3.0.3 JSON（GET /api/docs）+ Swagger UI CDN 静态页（GET /api/docs/ui）。

## 核心导出

- `discover.ts`：`discoverRoutes(table)` —— 走 Express Router 栈还原「方法+完整路径+defineRoute schema+鉴权姿态」；只收带 ROUTE_SCHEMA_META 的 defineRoute 路由，原始 handler（协议面/SSE/文件流）入 skipped；嵌套挂载：根挂载探测 matcher，静态路径挂载查 NESTED_MOUNT_HINTS 签名表（Express 5.2 layer 不留挂载路径字符串）
- `build.ts`：`buildOpenApiDocument(routes, skipped)` —— 装配文档：params/query 参数、requestBody、成功响应（response-map 命中用 contract schema，未命中退化通用 { data } 壳如实标注）、400/401/403/500 错误壳、bearerAuth security、x-studio-undocumented
- `response-map.ts`：端点 → contract xxxResponseSchema 装订表（响应 schema 正本在 contract，本表只做映射）；扩覆盖只动本表
- `index.ts`：`mountApiDocs(app, table)` —— GET /api/docs（JSON，首请求构建并缓存）+ GET /api/docs/ui（Swagger UI CDN 页）

## 注意事项

- 文档是 contract 的派生物不是正本：请求 schema 直接来自 defineRoute 实际挂载（零漂移）；响应 schema 靠 response-map 装订，防漂移靠 __tests__/openapi.probe.ts 断言「映射键 ⊆ 实际端点」。
- 协议面不进文档（discord/deploy webhook、lark/dingtalk 回调、SSE、MCP 消息面）——它们不是 defineRoute 路由，自然落 skipped，无需维护排除清单。
- 鉴权语义来自 route-registry 的 describeEntryAuth（姿态数组模块级共享，按数组引用判别）。
