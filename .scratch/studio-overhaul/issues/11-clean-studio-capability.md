# 11 — studio-capability 死代码清理

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-capability 中：company-mcp-pool.ts（574 行纯内存 Map 占位实现、零引用零测试）与能力市场四方法（约 170 行零调用，purchase() 带 FIXME 恒空转）。连带孤儿类型/测试/导出。证据 research/04。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `9c7ef504`（5 files, +4/−759）。删 company-mcp-pool.ts 574 行 + 市场四方法约 170 行 + index.ts 导出；CONTEXT/CAPABILITIES 文档同步。复扫确认零活引用。typecheck exit 0，test 4200 passed / 0 failed。
