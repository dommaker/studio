# 44 — studio-shared stance/user-behavior 零消费文件清理

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

工单 16 复扫新发现：packages/studio-shared/src/ 下 stance.ts 与 user-behavior.ts 两个整文件实际零消费（harness 相关姿态注入/用户行为提取，确认无活引用后整文件删除，连带 index/node 再导出、孤儿测试、相关类型）。删前再次完整 grep 复扫（含字符串形式、stance/Stance/user-behavior/UserBehavior 各导出名）。验收：grep 零残留，typecheck+test 全绿（当前基线 4095 passed / 0 failed），独立 commit。

## Answer

已解决，commit `cae3eac9`。删 types/stance.ts（170 行 12 导出）+ types/user-behavior.ts + index/node 三行再导出；13 个导出名 word 级复扫零活引用。typecheck exit 0，test 4087 passed / 0 failed。
