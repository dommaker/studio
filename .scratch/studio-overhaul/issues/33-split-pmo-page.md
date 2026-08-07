# 33 — PMOPage.tsx 拆分（E1）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 21

## Question

拆分 apps/web/src/pages/PMOPage.tsx（929 行）：抽出 3 个自包含弹窗 + okrMetric 纯函数（削约 40%），按 research/02 标出的缝。纯搬运不改逻辑。验收：typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `a4b0a372`。PMOPage 929→403 行（削 57%），抽出 components/pmo/ 四件：okrMetric.ts（纯函数）、CreateOkrDialog/CreateProjectDialog/PublishProjectDialog 三弹窗。纯搬运，CONTEXT 同步。typecheck exit 0，test 3957 passed / 0 failed。
