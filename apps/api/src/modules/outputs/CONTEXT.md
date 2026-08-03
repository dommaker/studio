# outputs

> 此文件描述 apps/api/src/modules/outputs 目录的职责和上下文

## 职责

负责执行结果产出文档的存储和检索。通过文件系统持久化文档内容，并利用 EventStore 维护索引，提供 HTTP API 供外部查询某一执行的所有产出文档。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `saveOutput` | `routes.ts` | 异步函数，保存单个产出文档到文件系统并更新 EventStore 索引，返回文件路径和文件名。 |
| `router` | `routes.ts` | Express Router 实例，挂载 `GET /:executionId` 路由，根据执行 ID 返回该执行的所有产出文档列表。 |

## 依赖关系

**上游（本目录依赖）**
- `apps/api/src/core/event-store`：提供 `EventStore` 实例，用于存储产出文档的文件名、步骤 ID、大小和创建时间等元数据索引。
- `apps/api/src/utils/logger`：输出操作日志。
- `apps/api/src/middleware/auth`：使用 `requireNotGuest` 和 `requireRole` 中间件进行权限控制（SEC-001 / SEC-002 安全策略）。
- 第三方库：`express`、`fs`、`path`、`uuid`。

**下游（依赖本目录）**
- `apps/api/src/route-registry.ts`：引用本模块的 `router` 将其注册到主应用的路由系统中。

## 注意事项

- 文档存储目录由环境变量 `OUTPUTS_DIR` 指定，若未设置则默认为 `<cwd>/.harness/outputs/`。
- 文件系统写入使用同步 `writeFileSync`，可能阻塞事件循环，生产环境应考虑异步版本或流式写入。
- 使用了 `requireNotGuest` 和 `requireRole` 中间件，确保接口受身份验证和角色限制。
- 路由回退逻辑：当 EventStore 索引为空时，会尝试从文件系统直接读取目录列表，以兼容历史数据或未建立索引的场景。
- **已知风险（2026-07-24 记录）**：行为未变（DELETE 原有 requireRole('Admin')）；GET /:executionId 的 fs 回退分支回显服务器绝对路径；GET /:executionId/:filename 直接 path.join 无归一化校验，可 `../` 目录穿越（两者均需过大门，未修）。
