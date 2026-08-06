# 13 — studio-agent agent-completer 删除

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-agent 的 agent-completer.ts（229 行 + 测试，整模块零引用）及 types 导出中无人消费、apps 各自重定义的同名 interface 残余（逐一核对后删）。证据 research/04。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `d032a6c9`（6 files, +2/−425）。删 agent-completer.ts 229 行 + 13 个测试 + index.ts 四个死类型再导出 + types.ts 孤儿 interface（AgentMetadata/JSONSchema 等包内自用定义保留，仅删无人消费的再导出）。复扫 17 处外部 import 无一消费拟删项。typecheck exit 0，test 4170 passed / 0 failed（与基线差值吻合）。
