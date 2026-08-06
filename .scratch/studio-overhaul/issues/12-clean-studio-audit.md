# 12 — studio-audit 清理

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-audit 中 audit-chain.ts（446 行哈希链全仓零引用）与 mock 数据的 bin CLI（与真实服务未接线）。连带孤儿与 package.json bin/导出引用。证据 research/04。验收：grep 零残留，typecheck+test 全绿，独立 commit。
