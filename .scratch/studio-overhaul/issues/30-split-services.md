# 30 — workunit/okr/metrics 拆分（D2c）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 20

## Question

按 research/01 标出的缝拆分三个文件：workunit.service.ts（1179 行，先抽头部 300 行类型/mapper）、pmo/okr.service.ts（1156 行，抽 550 行指标引擎）、monitoring/metrics.service.ts（666 行，85% 是作者已画缝的纯函数区）。纯搬运不改逻辑。验收：typecheck+test 全绿，每个文件至少一个独立 commit。

## Answer

已解决，3 个 commit（`9005e396`/`9f73f649`/`240ba084`）。workunit.service 1179→889 行（抽 workunit.types.ts 228 行 + workunit.mappers.ts 85 行，re-export 兼容；F6 台账/父状态聚合深度耦合 this，纯搬运安全边际外不再切）；metrics.service 666→113 行（抽 metrics.types.ts 153 行 + metrics-aggregate.ts 444 行，service 仅余数据加载+缓存薄壳）；okr.service 按工单 20 结论跳过。typecheck 每票前 exit 0，test 3944 passed / 0 failed。
