# 19 — api 废弃模块清理

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 apps/api 废弃模块：environments 模块（疑似零调用方，删前最后复核 scripts/、docs、bin/ 引用）、spec-reviews 模块（路由注册但前端零调用无测试）、outputs 模块（链路已坏）、knowledge Resolution 影子库双实现（保留主实现，删影子）。连带路由注册、菜单/文档引用、孤儿类型。证据 research/01、03。验收：grep 零残留，typecheck+test 全绿，独立 commit。
