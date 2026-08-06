# 19 — api 废弃模块清理

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 apps/api 废弃模块：environments 模块（疑似零调用方，删前最后复核 scripts/、docs、bin/ 引用）、spec-reviews 模块（路由注册但前端零调用无测试）、outputs 模块（链路已坏）、knowledge Resolution 影子库双实现（保留主实现，删影子）。连带路由注册、菜单/文档引用、孤儿类型。证据 research/01、03。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## 追加范围（自工单 10 移交）

- runtime-config 模块：注册中的活路由，但其服务对象（任务队列）已随 studio-task 下线消失；评估整体下线或裁剪队列相关部分，连带 web 端「TaskWorker 热更新」注释引用。

## Answer

已解决，两个 commit：`b884d542`（environments/spec-reviews/outputs 三模块 + route-registry 注册清理）、`f203fc7d`（runtime-config 整体下线 + knowledge Resolution 影子库删除，/match-resolutions 迁移主实现 resolution.service，web 端 Settings 两 section 与 runtimeWorkflowApi 连带清理）。runtime-config 取舍：整体下线（三字段+reload 全服务于已删 TaskWorker，web 唯一调用方为死写）。typecheck exit 0，test 4050 passed / 0 failed。

执行发现移交：① agent-configs/routes.ts 前端零调用 → 移交工单 20 评估；② mcp/spec.tools.ts（MCP 工具面，有测试）直接读写 spec-reviews 数据目录，仍存活，不在范围保留。
