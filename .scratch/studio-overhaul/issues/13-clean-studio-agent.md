# 13 — studio-agent agent-completer 删除

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-agent 的 agent-completer.ts（229 行 + 测试，整模块零引用）及 types 导出中无人消费、apps 各自重定义的同名 interface 残余（逐一核对后删）。证据 research/04。验收：grep 零残留，typecheck+test 全绿，独立 commit。
