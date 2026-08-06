# 29 — knowledge-service.ts 拆分（D2b）

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 19

## Question

拆分 apps/api/src/modules/knowledge/knowledge-service.ts（1819 行）：先抽 Measure 块 350 行（最干净）为独立模块，再按 research/01 标出的缝切分其余。工单 19 已删 Resolution 影子库后再动。纯搬运不改逻辑。验收：typecheck+test 全绿，每抽一块一个 commit。
