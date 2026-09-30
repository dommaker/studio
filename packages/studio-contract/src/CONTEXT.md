# studio-contract

## 职责

API 契约唯一正本（docs/architecture/target-architecture.md）：按域一个文件的 zod schema，定义请求/响应形状；envelope.ts 定义统一响应壳（`{ data }` / `{ data, pagination }` / `{ error: { code, message } }`）。

## 核心导出

- `envelope.ts`：`errorBodySchema` / `paginationSchema` / `dataBodySchema` / `paginatedBodySchema` / `ERROR_CODES`
- `workunit.ts`：workunit 域（首个迁移域，后续 30+ 域的模板）——WorkUnit 实体 + 各端点请求（body/query/params）+ 响应 schema 与类型
- `channels.ts`：channels 域——Channel/ChannelMessage 实体 + 派生读形状（current-pmo/pmo-candidates/suggestions/merge-target/file-vocabulary）+ 端点请求/响应；消息分页 `{ messages, total, hasMore }`（cursor 壳）
- `requirements.ts`：requirements 域——Requirement 实体（含 B3a projectId）+ chain/chain-stats 形状 + 端点请求/响应

## 注意事项

- 只依赖 zod；禁止引入 Node 内置模块依赖（前端 apps/web 也 import 本包）。
- schema 即正本：改字段 = 改这里，前后端编译期同时报错，这是本包存在的意义。
- **z.infer 在本仓退化**：仓 tsconfig strict:false（strictNullChecks off），zod 的 requiredKeys 类型检测全部失效 → z.infer 所有字段变可选。消费方需要必填字段类型的实体（如 WorkUnit）用手写 interface + parity 测试（interface fixture ↔ schema 互验，见 workunit.test.ts）兜漂移；请求/内嵌结果类型 z.infer 全可选无害可继续用。**判定标准是消费方而非形状**：channels/requirements 迁移中发现 ChannelMessagesResult/RequirementChain/RequirementChainWorkUnit/ChainStatEntry 的下游（store 合并、管道页、徽章）按必填消费，同样要手写 interface；请求 body 喂给带必填字段的 service 入参时（channels create agents / send files），在路由边界显式收回（map + as string）。
- **defineRoute 配套两坑**（channels 迁移实测）：①handler 里要读「zod 已剥掉的未知键」时（如退役字段守卫 defaultProfileId），schema 须 `.passthrough()` 否则守卫永远看不到；②二进制流 handler（pipe res）必须等 finish 再返回——handler 同步返回时 headersSent 尚未置位，defineRoute 会 res.end() 截断流。
- OpenAPI 文档由本包派生，不手写 yaml。
