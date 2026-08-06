# 24 — 后端 bug 修复（C1-C3）

Type: task
Status: resolved
Labels: bug, ready-for-agent

## Question

修复三个运行中 bug（证据 research/01）：C1 worktree GC 目录口径不一致（ops.service.ts:528 扫描目录 ≠ agent-loop.ts:1623 实际创建目录，统一到实际创建口径）；C2 channel 分页 limit 失效（channel.routes.ts:322）；C3 auth 类型漂移（middleware/auth.ts 与 auth/service.ts 的 UserData/SessionData 统一为单一来源）。每个 bug 一个独立 commit，附带针对性测试或既有测试验证。验收：typecheck+test 全绿。

## Answer

已解决，三个 commit：
- C1 `bbb8b53a`：GC 默认扫描口径 ~/.studio/worktrees 与创建侧 ~/worktrees 不一致（一直在扫空目录），ops.service 与 system-health 两处统一到创建侧；新增 3 用例。
- C2 `ba8c1443`：GET messages 只在 hasMore 时 pop 从未 slice，limit 白设；改 slice(0,take) 页内升序；新增 3 用例。
- C3 `f0d55012`：middleware/auth.ts 删本地 UserData/SessionData 定义，从 service.ts（唯一写入方）import 并 re-export，外部路径不变。
typecheck exit 0，全量 test 3939 passed / 0 failed（+6 新用例）。
