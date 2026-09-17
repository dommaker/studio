# hooks 层收缩与约束分拣标准（2026-09-17）

> 来源：#562 grilling 裁决（三轮：事实核查 → 第一性分析 → 裁决）；状态：**active**。

## 背景

2026-05 的 harness 接入审计（`docs/_archive/harness-integration-gaps.md`）发现 harness 接入是散落在
20+ 文件的 ad-hoc import、96 个该接入的点接通率 <10%，根因定性为「接入不是架构一等公民」。方案是建
统一 Hook 层（7 个业务 hook 按执行阶段挂 harness 约束检查）+ 防漂移机制（闭环校验、覆盖率脚本），
目标是让约束检查在每个业务时机真正发生、「做不到忘记」。

2026-09 核查（#562）发现该层已成死面，且比表面更彻底：

- HookRegistry/HookPipeline 注册齐全、闭环校验挂 build 全绿，但**管线零生产调用**；
- 唯一「生产」直调点（`runner-execution.ts` 的 `beforeAgentExecute`）所在的 `executeSessionLoop`
  本身无生产调用方——生产全走 `executeLightweight`，其头注释明示跳过 Iron Laws；
- 即 7 个 hook 实现体与约束 prompt 注入在生产均零执行；闭环校验是自指的（只证「声明↔注册」闭环，
  证不了「生产有人调」）；
- 业务生命周期已换代：Goal 模型删除、会议模块移除、约束检查时机被 `beforeClaim` 重新设计
  （`docs/specs/arch/agent-network-migration.md`）——hook 当初挂的时机点大部分不存在了。

## 决策

1. **hooks 层整体收缩**（同 ADR-0022「零生产消费者」判据）：删 `studio-shared/src/harness/hooks/`
   整目录与配套测试、`hooks-closure-check`（含 build 挂载）、`harness-coverage` hook 清单段、
   `bootstrap.ts` 的 `getPipeline()` 与注册调用；连带删死路径 `executeSessionLoop` /
   `AgentRunner.execute` / `buildPrompt` / `buildAgentConstraintPrompt` / `runner-briefing.ts`
   （该路径的双胞胎 session-manager.ts 已于 2026-08 按同判据删除）。
2. **保留活通道**：`propagateHarnessConfig` + CLAUDE.md 复制进 worktree（文件级约束传递）、
   `buildAugmentedPrompt`、`parseSessionMetrics` 等活消费；`bootstrapHarness` 初始化本体。
3. **约束分拣标准**（供 #586 约束引擎评估使用）：约束分两类——**通用行为纪律**（教模型怎么干活，
   随模型能力进化贬值，候选退役）与**项目特异事实**（伪装成约束的知识，模型永不能原生知道，
   候选迁移知识层）。依据 vision-2026 §6「约束是对模型能力的补充——模型在进化，约束必须同步进化」。
4. **衍生**：#585 补「需求/AC 存在」前置守卫（`no_implementation_without_requirement` 前置检查
   的唯一实质缺口，补进 step-guards 链）；#586 约束引擎整体分拣评估；#583 关闭（前提消失）。
   harness 侧 `runOne`（已随 1.8.1 发布、当前零消费者）与 `HookPipeline` 是否按 ADR-0022
   收缩由 harness 仓独立裁决。

## 为什么是收缩而不是接线（第一性论证）

编排方对 agent（独立 CLI 进程）的施力通道只有四个：spawn 前决断、prompt 文本、worktree 文件、
事后验收。过程行为类约束（验证先行、一次一事等）约束的是 agent 干活**过程中**的行为，编排方在
spawn 前跑检查是范畴错误——违规尚未发生、发生后也拦不到；这类约束的有效通道（文件、事后验收）
一直在生产上活着。前置条件类约束是硬门唯一合法作用域，但已被 step-guards / completion-gates
结构链接管（类型化上下文、参与 loop 控制流、可直测）。管线在 studio 无独占交付价值。

## 后果

- 后续若需恢复某条运行时硬检查，应挂在 agent-loop 守卫链（step-guards / completion-gates）上，
  **不重建 hook 管线**。
- 约束文本的存续问题不归本 ADR——由 #586 按分拣标准逐条评估。
