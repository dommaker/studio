# 14 — studio-spec SpecValidator 集群删除

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 packages/studio-spec 的 SpecValidator 集群（562 行零引用）与 package.json 中假依赖（声明的 studio-notification 依赖实为字符串字面量）。连带孤儿测试/导出。证据 research/04。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `d69d078f`（11 files, −1007 行）。删 SpecValidator 集群 4 源文件 + 测试 + 孤儿 validation.types.ts + 假依赖 studio-notification；index.ts/CONTEXT/lockfile 同步。复扫确认零活引用（architecture-validator 的外部引用已在工单 09 清除，按证据删除）。typecheck exit 0，test 4160 passed / 0 failed。
