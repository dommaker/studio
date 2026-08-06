# 25 — 前端 bug 修复（C4-C5）

Type: task
Status: resolved
Labels: bug, ready-for-agent

## Question

修复两个前端 bug（证据 research/02）：C4 `/projects/:id` 死路由（PmoNumberBadge:61 跳到不存在路由——修正跳转目标或在 App.tsx 补路由）+ App.tsx:193-222 补 404 兜底路由；C5 Settings 通知配置重启丢失——定位持久化链路断点并修复。每个 bug 一个独立 commit。验收：typecheck+test 全绿，交互路径人工核对（代码级）。

## Answer

已解决，两个 commit：
- C4 `5d371deb`：PmoNumberBadge 跳 `/projects/:id`（不存在）→ 改 `/project/:projectId`；新增 NotFoundPage + `path="*"` 兜底；新增 4 测试。
- C5 `50ce15b3`：断点在后端 outbound-notify/routes.ts 的 userConfig 仅存进程内存；改落盘 ~/.studio/notify-config.json + 模块加载自动恢复；重写测试为临时 HOME 隔离（含模拟重启恢复用例）。
typecheck exit 0，全量 test 3944 passed / 0 failed。
