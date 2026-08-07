# 28 — agent-loop.ts 拆分（D2a）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 18, 19, 20, 24, 27

## Question

拆分 apps/api/src/modules/agents/agent-loop.ts（2017 行）：先抽尾部 430 行零依赖纯函数（1584-2017）为独立模块，再按 research/01 标出的缝继续切分剩余区块。纯搬运不改逻辑。验收：typecheck+test 全绿，每抽一块一个 commit。

## Answer

已解决，6 个 commit（`729e357c`/`f6d9c798`/`b91b45bf`/`8e39cf0d`/`6fe1ffb2`/`04921a55`）。agent-loop.ts 2024→1542 行，抽出 5 个模块：agent-loop.types.ts（51 类型契约）、agent-loop-parsers.ts（221 协议解析+prompt）、agent-loop-events.ts（174 事件落盘）、agent-loop-guards.ts（35 守卫）、knowledge-search-analysis.ts（63）。纯搬运，对外 re-export 不变，测试/mock 零改动。typecheck 每票前 exit 0，test 全绿 3952 passed / 0 failed。

遗留移交：knowledge-search-analysis 块无生产调用方（仅单测消费）→ 移交工单 43 评估删除。
