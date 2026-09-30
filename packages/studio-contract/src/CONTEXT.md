# studio-contract

## 职责

API 契约唯一正本（docs/architecture/target-architecture.md）：按域一个文件的 zod schema，定义请求/响应形状；envelope.ts 定义统一响应壳（`{ data }` / `{ data, pagination }` / `{ error: { code, message } }`）。

## 核心导出

- `envelope.ts`：`errorBodySchema` / `paginationSchema` / `dataBodySchema` / `paginatedBodySchema` / `ERROR_CODES`
- `workunit.ts`：workunit 域（首个迁移域，后续 30+ 域的模板）——WorkUnit 实体 + 各端点请求（body/query/params）+ 响应 schema 与类型

## 注意事项

- 只依赖 zod；禁止引入 Node 内置模块依赖（前端 apps/web 也 import 本包）。
- schema 即正本：改字段 = 改这里，前后端编译期同时报错，这是本包存在的意义。
- **z.infer 在本仓退化**：仓 tsconfig strict:false（strictNullChecks off），zod 的 requiredKeys 类型检测全部失效 → z.infer 所有字段变可选。消费方需要必填字段类型的实体（如 WorkUnit）用手写 interface + parity 测试（interface fixture ↔ schema 互验，见 workunit.test.ts）兜漂移；请求/内嵌结果类型 z.infer 全可选无害可继续用。
- OpenAPI 文档由本包派生，不手写 yaml。
