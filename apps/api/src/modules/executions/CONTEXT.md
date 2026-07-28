# executions

> 此文件描述 apps/api/src/modules/executions 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/executions/CONTEXT.md, apps/api/src/modules/executions/routes.ts

## 职责

提供执行（execution）相关的 REST API 路由，当前仅包含获取执行列表（GET /）。基于本地 JSONL 文件和 tasks 目录的 FileStore 实现，不依赖已删除的数据库。此模块为遗留接口（LEGACY surface），仍被前端调用，但计划迁移至 agent-profiles / workunit API，迁移前不建议扩展新功能。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `router` (Express Router) | `routes.ts` | 注册了 GET / 路由，返回执行列表（支持分页、状态过滤，含进度计算）。

## 依赖关系

- **上游依赖**：
  - `express`：Router、Request、Response
  - `uuid`：生成唯一标识
  - `os`、`path`、`fs`：构建文件路径、读取目录
  - `@dommaker/studio-shared`：FileStore 和 logger
  - `../../core/event-store.js`（可能未直接使用，但 import 了 eventStore）
- **下游依赖**：
  - `apps/api/src/route-registry.ts`：引用本模块的路由器并挂载到 Express 应用。

## 注意事项

- 本模块标记为 LEGACY surface，迁移前请勿在此扩展新功能。
- 所有数据读写均基于本地文件系统（`~/.studio/logs/executions.jsonl` 和 `~/.studio/data/tasks/`），不依赖数据库。
- `findTaskByExecutionId` 辅助函数会遍历 `TASKS_DIR` 下的所有 JSON 文件，需注意文件数量较多时的性能。
- 路由 GET / 默认按 `createdAt` 降序排列，分页参数为 `page` 和 `limit`（默认 1/20）。
- 该模块的长期规划是废弃并被 agent-profiles / workunit API 替代（见 `docs/vision-2026.md`）。
- **已知风险（2026-07-24 记录）**：行为未变；POST /events 无任何鉴权/签名（内部 runtime 回调假设，全仓无调用方，生产靠大门兜底，建议后续 requireLocalhost 或共享密钥）；GET /:executionId 与 POST /:executionId/archive 回显服务器绝对路径。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `6f263685`: p0): 信任链六项修复 — 失败误判/超时机制/reviewReport回传/告警出口/日志隔离/traceId
- ✅ 2026-07-27: P0 修复 5 — executions.jsonl 读路径走 utils/studio-log-path 测试隔离（生产行为不变）
- ✅ 2026-07-24: 记录 /events 无凭证回调与路径回显风险（未修，另立项）
- ✅ `1773bfdf`: db-removal): migrate 11 files from Prisma → FileStore (59 calls eliminated)
- ✅ `b85449b1`: db-removal): final sweep — 全仓库 prisma 引用清零
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
- ✅ `a88bccd6`: tsc-gate surgical baseline update + fix 13 pre-existing TS errors
