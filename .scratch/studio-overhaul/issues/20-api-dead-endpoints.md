# 20 — api 死端点与 okr 死代码

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 apps/api 死端点：/metrics/routing（空端点）、/executions/:id/archive、/pmo/okr/metrics、/pmo/okr/data-health，及 pmo/okr-anomaly-detector.ts（仅自测引用）、okr.service 5 个仅测试引用方法 + 恒 false 死权限分支、agents/types.ts 6 个 merge/review 类型残余。连带前端死调用点（若有）与孤儿测试。注意：PMO OKR 主链路存活，只清死子端点。证据 research/01、03。验收：grep 零残留，typecheck+test 全绿，独立 commit。
