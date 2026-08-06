# 09 — 下线 studio-monitor 整包

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-monitor 整包（startHealthMonitor 全仓零调用，生产从未启动；证据 research/03、04）。连带：根/各包 package.json 与 pnpm-workspace 引用、apps/api 中 import 与关停钩子 no-op stop（index.ts:15,413）、相关文档/脚本引用。验收：grep 零残留引用，typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `ffa62505`（15 files, +3/-467）。整包删除 + index.ts import/no-op 钩子 + package.json 依赖清零；复扫额外清理 tsc-gate 包清单×2、checkpoints.yml、architecture-validator 白名单。typecheck exit 0，test 4242 passed / 0 failed（少的 4 个为被删包自带测试）。
