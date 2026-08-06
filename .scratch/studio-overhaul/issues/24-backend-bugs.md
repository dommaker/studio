# 24 — 后端 bug 修复（C1-C3）

Type: task
Status: open
Labels: bug, ready-for-agent

## Question

修复三个运行中 bug（证据 research/01）：C1 worktree GC 目录口径不一致（ops.service.ts:528 扫描目录 ≠ agent-loop.ts:1623 实际创建目录，统一到实际创建口径）；C2 channel 分页 limit 失效（channel.routes.ts:322）；C3 auth 类型漂移（middleware/auth.ts 与 auth/service.ts 的 UserData/SessionData 统一为单一来源）。每个 bug 一个独立 commit，附带针对性测试或既有测试验证。验收：typecheck+test 全绿。
