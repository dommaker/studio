# 10 — 下线 studio-task 整包与任务队列遗产

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-task 整包（官方注释自承"pipeline 时代队列，无存活生产者，默认关闭"，apps/api/src/index.ts:12）。连带：`/executions/worker/status` 死端点、STUDIO_TASK_QUEUE_ENABLED 配置项与文档、ioredis 依赖卸载、相关 import/类型引用。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `34d30ad7`（31 files, +7/−1870）。整包 + index.ts 关停分支 + /executions/worker/status 端点 + STUDIO_TASK_QUEUE_ENABLED + ioredis/node-fetch 卸载 + 门控/校验器清单同步。typecheck exit 0，test 4200 passed / 0 failed。

执行发现移交：① runtime-config 模块（活路由，服务对象已随队列消失）→ 移交工单 19 处置；② monitoring/index.ts 的 updateTaskQueueLength/taskQueueLength Gauge 死函数 → 移交工单 18；③ tsc-gate 清单含历史残留 studio-prisma → 移交工单 41 顺手处理。
