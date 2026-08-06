# 40 — 样式冲突清理（H）

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

消除 apps/web responsive.css 在媒体查询中覆写 Tailwind 同名工具类的冲突项（逐项列出冲突点，以 Tailwind 为准调整或删除覆写）；死样式已在工单 22 删除。不做全面样式统一。证据 research/02。验收：typecheck+test 全绿，冲突清单写入工单 Answer，独立 commit。
