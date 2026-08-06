# src

> 此文件描述 packages/studio-task/src 目录的职责和上下文

## 职责

提供任务队列管理（TaskQueue）和任务执行器（TaskWorker），以及任务相关的 CLI 命令（查看队列、运行、重试、清理）和类型定义，支撑 studio 的任务调度与执行能力。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `TaskQueue` | `services/task-queue.ts` | 基于 MemoryStore 的任务队列管理器，支持任务增删改查、事件记录 |
| `taskQueue` | `services/task-queue.ts` | TaskQueue 单例 |
| `RETRY_CONFIG` | `services/task-queue.ts` | 重试配置对象（maxRetries, retryDelay 等） |
| `Task` | `services/task-queue.ts` | 任务数据结构接口 |
| `TaskWorker` | `services/task-worker.ts` | 任务队列消费者，支持事件订阅和 HTTP API 调用 agent-runtime |
| `taskWorker` | `services/task-worker.ts` | TaskWorker 单例 |
| `WorkerConfig` | `services/task-worker.ts` | Worker 配置接口 |
| `runQueue` | `cli/queue.ts` | 查看任务队列 CLI 命令 |
| `runRun` | `cli/run.ts` | 运行任务 CLI 命令 |
| `runRetry` | `cli/retry.ts` | 重试任务 CLI 命令 |
| `runClean` | `cli/clean.ts` | 清理已完成/过期任务 CLI 命令 |
| `TaskListItem` | `types.ts` | CLI 命令中使用的任务列表项类型 |
| `QueueOptions`, `RunOptions`, `RetryOptions`, `CleanOptions` | `types.ts` | CLI 命令选项类型 |

## 依赖关系

- **上游依赖**：@dommaker/studio-shared（logger, memoryStore, FileStore）、node-fetch（HTTP 请求）、crypto（UUID）、os、path（Node 内置）
- **下游引用**：
  - apps/api（通过 src/index.ts 和 modules/executions/routes.ts 引用任务队列相关功能）

## 注意事项

- CLI 命令全部为异步函数，返回 `{ output: string; error?: string }` 结构
- CLI 命令使用静态 mock 数据（`mockTasks` 和 `companies`），实际开发需替换为真实数据源
- 任务状态流转：pending → running → completed/failed，支持 retry 状态
- TaskQueue 基于内存存储（MemoryStore），重启后数据丢失
- TaskWorker 支持事件订阅（优先）和 fallback 轮询机制，轮询间隔 1 分钟
- 重试配置默认 3 次，延迟递增（固定初始 5s，最大 60s）
- TaskWorker 从 `memoryStore['studio:worker:config']` 读取并发配置（字段 maxConcurrent）
- agent-runtime URL 默认 `http://localhost:3001`，可通过环境变量 `AGENT_RUNTIME_URL` 覆盖
