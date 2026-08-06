# 09 — 下线 studio-monitor 整包

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-monitor 整包（startHealthMonitor 全仓零调用，生产从未启动；证据 research/03、04）。连带：根/各包 package.json 与 pnpm-workspace 引用、apps/api 中 import 与关停钩子 no-op stop（index.ts:15,413）、相关文档/脚本引用。验收：grep 零残留引用，typecheck+test 全绿，独立 commit。
