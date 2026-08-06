# 30 — workunit/okr/metrics 拆分（D2c）

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 20

## Question

按 research/01 标出的缝拆分三个文件：workunit.service.ts（1179 行，先抽头部 300 行类型/mapper）、pmo/okr.service.ts（1156 行，抽 550 行指标引擎）、monitoring/metrics.service.ts（666 行，85% 是作者已画缝的纯函数区）。纯搬运不改逻辑。验收：typecheck+test 全绿，每个文件至少一个独立 commit。
