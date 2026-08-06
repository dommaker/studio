# 25 — 前端 bug 修复（C4-C5）

Type: task
Status: open
Labels: bug, ready-for-agent

## Question

修复两个前端 bug（证据 research/02）：C4 `/projects/:id` 死路由（PmoNumberBadge:61 跳到不存在路由——修正跳转目标或在 App.tsx 补路由）+ App.tsx:193-222 补 404 兜底路由；C5 Settings 通知配置重启丢失——定位持久化链路断点并修复。每个 bug 一个独立 commit。验收：typecheck+test 全绿，交互路径人工核对（代码级）。
