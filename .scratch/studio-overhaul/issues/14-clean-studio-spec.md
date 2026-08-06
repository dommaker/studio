# 14 — studio-spec SpecValidator 集群删除

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-spec 的 SpecValidator 集群（562 行零引用）与 package.json 中假依赖（声明的 studio-notification 依赖实为字符串字面量）。连带孤儿测试/导出。证据 research/04。验收：grep 零残留，typecheck+test 全绿，独立 commit。
