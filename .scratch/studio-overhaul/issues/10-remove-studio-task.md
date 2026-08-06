# 10 — 下线 studio-task 整包与任务队列遗产

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-task 整包（官方注释自承"pipeline 时代队列，无存活生产者，默认关闭"，apps/api/src/index.ts:12）。连带：`/executions/worker/status` 死端点、STUDIO_TASK_QUEUE_ENABLED 配置项与文档、ioredis 依赖卸载、相关 import/类型引用。验收：grep 零残留，typecheck+test 全绿，独立 commit。
