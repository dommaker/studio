# 21 — web 死组件清理

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 apps/web 16 个零引用根组件（含 7 个孤儿测试）与 review 四件簇（ReviewPanel/MultiStanceReviewPanel/ReviewOpinionCard/StanceBadge，封闭互引对外零引用）。逐项以 research/02、03 清单为准，删前 grep 复扫（含动态 import、字符串路由）。验收：grep 零残留，typecheck+test 全绿，独立 commit。
