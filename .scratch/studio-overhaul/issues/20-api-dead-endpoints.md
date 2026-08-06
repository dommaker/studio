# 20 — api 死端点与 okr 死代码

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 apps/api 死端点：/metrics/routing（空端点）、/executions/:id/archive、/pmo/okr/metrics、/pmo/okr/data-health，及 pmo/okr-anomaly-detector.ts（仅自测引用）、okr.service 5 个仅测试引用方法 + 恒 false 死权限分支、agents/types.ts 6 个 merge/review 类型残余。连带前端死调用点（若有）与孤儿测试。注意：PMO OKR 主链路存活，只清死子端点。证据 research/01、03。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## 追加范围（自工单 18 移交）

- monitoring/index.ts 其余 4 个零调用 prom-client 指标函数（recordApiRequest 等，research/01 亦点名）：确认零调用后删除。

## 追加范围（自工单 19 移交）

- agent-configs/routes.ts：前端零调用（仅文件级读 environments.json，已随 environments 模块删除而失源），评估删除。

## Answer

已解决，两个 commit：`a8c1b6f7`（14 files, −2016 行：4 死端点 + okr-anomaly-detector + okr.service 死方法/死权限分支，级联删 B8 度量引擎，okr.service 1156→334 行 + monitoring 4 个死指标函数）、`4461d2ab`（agent-configs 模块整删）。OKR 主链路保留（createDefaultOKR 为生产调用）。typecheck exit 0，test 3994 passed / 0 failed。

影响：工单 30 中 okr.service 拆分需求基本消解（剩 334 行），届时按实际体积取舍。
