# 28 — agent-loop.ts 拆分（D2a）

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 18, 19, 20, 24, 27

## Question

拆分 apps/api/src/modules/agents/agent-loop.ts（2017 行）：先抽尾部 430 行零依赖纯函数（1584-2017）为独立模块，再按 research/01 标出的缝继续切分剩余区块。纯搬运不改逻辑。验收：typecheck+test 全绿，每抽一块一个 commit。
