# 18 — api 死文件与孤儿代码第一刀

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 apps/api 中：channel.routes.ts:21-212 的 178 行无调用方死解析器、daemon/claim-loop.ts + task-executor.ts（574 行无生产实例化孤儿）、utils/crypto.ts、discovery-exposure.service.ts、gc-service.ts（三整文件零引用）、types/index.ts、utils/git.ts（纯死文件）。连带孤儿测试/类型/常量。证据 research/01、03。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## 追加范围（自工单 10 移交）

- apps/api/src/monitoring/index.ts 的 updateTaskQueueLength / taskQueueLength Gauge 死函数（studio-task 下线后孤儿）。
