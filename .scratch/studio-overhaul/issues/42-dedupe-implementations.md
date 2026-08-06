# 42 — 重复实现收敛（J）

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

收敛重复实现（证据 research/04）：frontmatter 解析 3 份 → 统一为 studio-shared 一份，调用点逐一切换；ID 生成同一模式 6 处 → 统一工具函数。行为不变。验收：typecheck+test 全绿，每项收敛独立 commit。
