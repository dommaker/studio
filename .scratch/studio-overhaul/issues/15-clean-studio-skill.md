# 15 — studio-skill 清理

Type: task
Status: claimed
Labels: enhancement, ready-for-agent

## Question

清理 packages/studio-skill：删除零引用的 matchIntent、definitions/ 空 stub、package.json 两个死依赖。证据 research/04。验收：grep 零残留，typecheck+test 全绿，独立 commit。
