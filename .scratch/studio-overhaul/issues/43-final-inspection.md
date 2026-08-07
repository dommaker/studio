# 43 — 最终架构巡检

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 44

## Question

全部执行工单闭环后，调用 improve-codebase-architecture 技能执行最终代码库架构巡检：模块深度/seam 健康度抽查（重点 FileStore、agents/ 重组结果、api 层、ui/ 通用件），额外专门检查：孤立死代码遗留（删除批次的连带孤儿是否清干净）、无用导入、零引用导出回潮、package.json 依赖与实际使用一致性、typecheck+test 最终全绿确认。产出巡检报告（.scratch/studio-overhaul/final-inspection.md）；发现的小遗留直接修复并独立 commit，大遗留开新工单。巡检通过且无遗留 → 全部闭环，删除 04:15 cron（id 9bbbe7ad），输出验收总结。

## 追加检查项（自工单 22 移交）

- apps/api 的 knowledge-bus-sync.test.ts 计时器 flake（vi.advanceTimersByTimeAsync + logger 计数），全量跑偶发失败、单跑稳定；巡检时评估修复或加固。

## 追加检查项（自工单 28 移交）

- agents/knowledge-search-analysis.ts：无生产调用方、仅单测消费，巡检时评估删除（连带其测试）。
