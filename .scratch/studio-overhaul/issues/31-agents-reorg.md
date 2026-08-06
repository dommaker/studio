# 31 — agents/ 目录按子域重组（D1）

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 28

## Question

apps/api/src/modules/agents/ 40 个源文件按 6 子域重组成子目录：loop / auditor / ops / monitor / knowledge / triage（以 research/01 的子域划分为准），import 路径同步收编。纯移动不改逻辑。验收：typecheck+test 全绿，独立 commit。
