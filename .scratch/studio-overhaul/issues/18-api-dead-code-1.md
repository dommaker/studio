# 18 — api 死文件与孤儿代码第一刀

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 apps/api 中：channel.routes.ts:21-212 的 178 行无调用方死解析器、daemon/claim-loop.ts + task-executor.ts（574 行无生产实例化孤儿）、utils/crypto.ts、discovery-exposure.service.ts、gc-service.ts（三整文件零引用）、types/index.ts、utils/git.ts（纯死文件）。连带孤儿测试/类型/常量。证据 research/01、03。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## 追加范围（自工单 10 移交）

- apps/api/src/monitoring/index.ts 的 updateTaskQueueLength / taskQueueLength Gauge 死函数（studio-task 下线后孤儿）。

## Answer

已解决，两个 commit：`37edb003`（daemon 孤儿 574 行 + crypto/git/types/discovery-exposure/gc-service 死文件 + 3 个孤儿测试 + 文档同步）、`705d61b7`（channel.routes 死解析器 193 行 + monitoring taskQueueLength 死 Gauge + 补删 2 个漏网孤儿测试）。五项复扫零生产引用，终态 grep 零残留。typecheck exit 0，test 4054 passed / 0 failed。

执行发现移交：monitoring/index.ts 其余 4 个零调用指标函数（recordApiRequest 等）→ 移交工单 20。
