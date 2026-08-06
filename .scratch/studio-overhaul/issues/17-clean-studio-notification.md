# 17 — studio-notification mock CLI 清理

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-notification 的 mock 数据 bin CLI（约 130 行，与真实服务未接线）及 package.json bin 引用。包本体保留。证据 research/04。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `8ad4531a`。删 src/cli/ 132 行 + 3 个孤儿测试 + 孤儿 types.ts + bin 声明 + 两行再导出；README 重写为服务说明，CONTEXT/CAPABILITIES 同步。复扫零活引用（apps/api 仅用 NotificationService）。typecheck exit 0，test 4087 passed / 0 failed。
