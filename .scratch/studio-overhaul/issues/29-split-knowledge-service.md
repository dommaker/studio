# 29 — knowledge-service.ts 拆分（D2b）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 19

## Question

拆分 apps/api/src/modules/knowledge/knowledge-service.ts（1819 行）：先抽 Measure 块 350 行（最干净）为独立模块，再按 research/01 标出的缝切分其余。工单 19 已删 Resolution 影子库后再动。纯搬运不改逻辑。验收：typecheck+test 全绿，每抽一块一个 commit。

## Answer

已解决，5 个 commit（`691434a8`/`4328f811`/`217b2b32`/`85f08e7b`/`d5d27850`）。knowledge-service.ts 1720→1143 行，抽出 5 模块：knowledge-metrics.ts（400 Measure 内核）、trend-data.ts、knowledge-form-gate.ts、conversation-extractor.ts（R3 管道）、knowledge-semantic-search.ts（RAG 支撑）。迁出符号经 re-export 保持导出语义，消费方零改动。typecheck 每票前 exit 0，test 3953 passed / 0 failed。
