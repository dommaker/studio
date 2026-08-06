# 17 — studio-notification mock CLI 清理

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-notification 的 mock 数据 bin CLI（约 130 行，与真实服务未接线）及 package.json bin 引用。包本体保留。证据 research/04。验收：grep 零残留，typecheck+test 全绿，独立 commit。
