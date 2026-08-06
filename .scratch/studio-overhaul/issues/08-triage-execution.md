# 08 — triage 拆解执行工单

Type: task
Status: open
Blocked by: 07

## Question

基于 07 的 spec，用 triage 技能把重构方案拆解为细小执行工单（单文件/单关注点粒度，1-3 commit/工单），写入 issues/ 并标注依赖关系。此后主循环逐工单执行：每处细小优化独立 commit，工单结束跑门控并更新 Status。全部执行工单闭环后追加最终巡检工单（improve-codebase-architecture，重点查孤立死代码与无用导入）。
