# 31 — agents/ 目录按子域重组（D1）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 28

## Question

apps/api/src/modules/agents/ 40 个源文件按 6 子域重组成子目录：loop / auditor / ops / monitor / knowledge / triage（以 research/01 的子域划分为准），import 路径同步收编。纯移动不改逻辑。验收：typecheck+test 全绿，独立 commit。

## Answer

已解决，3 个 commit（`89d3c2ed`/`983c8561`/`f28a8061`）。46 个源文件按 6 子域重组：loop/15、auditor/4、monitor/6、ops/3、knowledge/4、triage/1，根目录留 12 个共享/legacy。import 全链同步（50 测试/route-registry/cli 动态 import/跨模块引用/glob 字符串），git mv 保历史，CONTEXT.md 同步并修正三处漂移名。typecheck 每票前 exit 0，test 3953 passed / 0 failed。
