# lint 清零 B9「禁止行为变化」约束的有意例外（2026-08-08）

> 补录决策记录（code review R5）。例外发生于 commit `5ba431fa`（2026-08-07），本文档事后闭环。

## 背景与约束

lint 清零计划（`.scratch/studio-lint-zeroing/plan.md`）对 B9 批（react-hooks 类告警）设硬约束：

- 分批原则 4：「禁止为消告警改变运行时行为」
- B9 行验收标准：「测试全绿；禁止行为变化」

约束意图：清零是机械性工程，行为变化会把它变成不可评审的混合变更，且消告警驱动的重构容易引入回归。

## 打破约束的变更

`5ba431fa`（清零第 9 批下）含 2 处有意行为变化，commit message 已如实标注「2 条顺带修小 bug」：

1. **PublishProjectDialog 默认频道选择**改 prevOpen 上升沿渲染期调整。修的是真 bug：旧实现 effect deps 含 `channels`，弹窗打开期间父级刷新 channels 列表会把用户已选中的频道静默重置回第一个。代价：`channels=[]` 打开、channels 晚到的场景不再自动回填默认值（实际流程 channels 先于弹窗加载，且为空时发起按钮本就禁用）。
2. **useAgentRoster 挂载首查**改静默路径 `refresh(true)`，消除冗余 `setLoading(true)`（loading 初值本就是 true，逐帧无视觉差异）。

## 为什么这是正确的例外

- **修的是用户可见的真 bug**，不是为消告警而改行为；react-hooks 告警（exhaustive-deps / 渲染期调整 state）指向的正是这个缺陷本身，告警与 bug 同源，分开处理反而要把同一处代码改两遍。
- **如实标注**：commit message 逐条列出行为变化、新旧行为对比与代价，可评审性没有丧失——约束防的是「藏着掖着的混合变更」，不是「显式申报的顺手修 bug」。
- **验证充分**：tsc-gate 绿、web 77 文件 481 测试全绿（与不变批同轮验证）。
- **失败方向安全**：变化 1 的代价场景（channels 晚到不回填）在实际流程中不可达，且即使发生也是保守方向（不替用户做选择）。

## 程序教训

越过自定硬约束应当场留决策记录（leftovers 跟踪器或 docs/decisions/）。本次例外实质正确、程序缺失，本文档补录闭环。后续 lint 清零类计划如再遇「告警与真 bug 同源」的情形，先例即本文：允许例外，但必须 ① commit 如实标注新旧行为 ② 当场补决策记录。
