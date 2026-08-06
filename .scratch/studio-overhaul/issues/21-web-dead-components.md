# 21 — web 死组件清理

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 apps/web 16 个零引用根组件（含 7 个孤儿测试）与 review 四件簇（ReviewPanel/MultiStanceReviewPanel/ReviewOpinionCard/StanceBadge，封闭互引对外零引用）。逐项以 research/02、03 清单为准，删前 grep 复扫（含动态 import、字符串路由）。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## Answer

已解决，三个 commit：`b3b87559`（16 个零引用根组件 + 孤儿测试 + theme.css 尾部 meeting 时代死样式 230 行 + superpowersApi 死导出）、`59c0025e`（review 四件死簇 + 簇内类型）、`0cb9959f`（TaskCard 孤儿 e2e）。复扫纠正两处研究误判：IronLawWarningBanner 实为零引用已删；PMOCard/CompanyHallCard 实为活链保留。typecheck exit 0，test 3939 passed / 0 failed。

影响：IronLawsSection/DeleteButton 已删，工单 37 裸 fetch 存活清单相应缩小（其工单本就约定以存活清单为准）。
