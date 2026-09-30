# studio-contract

## 职责

API 契约唯一正本（docs/architecture/target-architecture.md）：按域一个文件的 zod schema，定义请求/响应形状；envelope.ts 定义统一响应壳（`{ data }` / `{ data, pagination }` / `{ error: { code, message } }`）。

## 核心导出

- `envelope.ts`：`errorBodySchema` / `paginationSchema` / `dataBodySchema` / `paginatedBodySchema` / `ERROR_CODES`
- 域文件（按需新增）：每域导出请求/响应 schema 及其 `z.infer` 类型

## 注意事项

- 只依赖 zod；禁止引入 Node 内置模块依赖（前端 apps/web 也 import 本包）。
- schema 即正本：改字段 = 改这里，前后端编译期同时报错，这是本包存在的意义。
- OpenAPI 文档由本包派生，不手写 yaml。
