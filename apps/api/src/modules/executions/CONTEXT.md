# apps/api/src/modules/executions

### 职责

提供执行（execution）相关的 REST API 路由，当前仅包含获取执行列表（GET /）。基于本地 JSONL 文件和 tasks 目录的 FileStore 实现，不依赖已删除的数据库。此模块为遗留接口（LEGACY surface），仍被前端调用，但计划迁移至 agent-profiles / workunit API，迁移前不建议扩展新功能。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `router` (Express Router) | `routes.ts` | 注册了 GET / 路由，返回执行列表（支持分页、状态过滤，含进度计算）。

### 依赖关系

- **上游依赖**：
  - `express`：Router、Request、Response
  - `uuid`：生成唯一标识
  - `os`、`path`、`fs`：构建文件路径、读取目录
  - `@dommaker/studio-shared`：FileStore、eventBus（runtime 事件经 eventBus.publish 发到 `events` 频道）和 logger
- **下游依赖**：
  - `apps/api/src/route-registry.ts`：引用本模块的路由器并挂载到 Express 应用。

### 注意事项

- 本模块标记为 LEGACY surface，迁移前请勿在此扩展新功能。
- 所有数据读写均基于本地文件系统（`~/.studio/logs/executions.jsonl` 和 `~/.studio/data/tasks/`），不依赖数据库。
- `findTaskByExecutionId` 辅助函数会遍历 `TASKS_DIR` 下的所有 JSON 文件，需注意文件数量较多时的性能。P2-e：遍历走 FileStore `listJsonInDir` seam，executions.jsonl 状态同步全量重写走 `writeJsonl`（原子写），模块内已无裸 fs。
- 路由 GET / 默认按 `createdAt` 降序排列，分页参数为 `page` 和 `limit`（默认 1/20）。
- 该模块的长期规划是废弃并被 agent-profiles / workunit API 替代（见 `docs/vision-2026.md`）。
- **已修复（2026-08-25）**：POST /events 已挂 requireLocalhost（内部 runtime 回调假设坐实：全仓无远程调用方）；GET /:executionId 回显服务器绝对路径（POST /:executionId/archive 已随工单 20 删除）。
- **契约驱动迁移（2026-10 批次 7/8）**：三端点走 defineRoute（schema = studio-contract executions.ts，LEGACY 标注）——GET / 分页壳形状不变；GET /:executionId 裸实体进 `{ data }` 壳；POST /events `{ received }` 进壳（唯一调用方同机 agent-runtime 不解析响应体）；500 code 'INTERNAL_ERROR' 归一 INTERNAL。头部注释声称的 web executionApi 消费方经 grep 实证已不存在，注释同批修正。
