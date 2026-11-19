# 2026-07 飞轮/监控未接通项（②③④ 合集）

> 依据：2026-07-20 三服务价值复核审计（monitor/auditor/knowledge-agent）。三事项共同特征：**价值真实、机制在位、断点明确且小**，合并为一批处理。
> 状态：待排期，建议一次做完（相互独立，均为小改动）。
> 执行轨道：②③ 归 **β（知识服务轨道，见 `2026-07-knowledge-review-loop.md`）**——与审核闭环同文件 `knowledge-service.ts`；④ 归 **γ（数据/类型修复轨道，见 `2026-07-knowledge-type-repair.md`）**——与 R2 同文件 `agent-loop.ts`。

## ② rule/context 注入档生产恒空（sourceReference 单复数 bug）

- **现象**：`injectContext` 的 rule/context 两档在生产永远注入 0 条，实际注入只剩 ≤5 条 signal 一行索引（`unified-query.ts:175-177` 的 `slice(0, limit=5)`）。
- **根因**：过滤条件读 `r.sourceReference`（单数），生产条目字段是 `sourceReferences`（复数，`harness/src/knowledge/types.ts:42`）→ 条件恒 false。位置：`knowledge-service.ts:665`（rule 档）、`:674`（context 档）。单测绿是因为 mock 了单数字段（`knowledge-service.test.ts:357,370`）——测试形状与生产形状不一致。
- **修法**：改读 `sourceReferences`（取 `length > 0` 判断）；同步修正测试 fixture 为生产形状。
- **验收**：构造含 rule/context 条目的知识库，注入 prompt 中出现两档内容；新增"复数字段"形状的回归测试。

## ③ 2K 注入红线无执行（只有事后度量）

- **现象**：vision D6「注入 ≤2K tokens」只有看板度量（`monitoring.service.ts:310-311` 实算 `injectedBudgetUsedPct`，有测试），无任何执行点；`injectContext` 的参数名为 `_opts`，`maxTokens` 被显式忽略（`knowledge-service.ts:658`）。
- **可复用**：harness 有 budget-aware 的 `KnowledgeInjector`，但 `sharedInjector` 仅测试引用未接线（`knowledge-singletons.ts:53`）。
- **修法（从简）**：`injectContext` 内实施裁剪——候选条目按注入优先级（成熟度 → 引用计数）排序，逐个累加 `TokenEstimator.estimateText`（TokenEstimator 口径），超 2000 截断并记 `knowledge:inject-trimmed` 事件。不急于接线 sharedInjector（更大改造，另议）。
- **验收**：构造 >2K 候选的库，实际注入估算 ≤2K；`workunit:tokens` 事件 `injectedTokens` ≤2000；看板 `budgetUsedPct` ≤100%；裁剪事件可在事件流中查到。

## ④ token 预算告警数据源（恢复已删 probe 的前提）

- **背景**：`checkTokenBudget` probe 已在 2026-07-20 清理批删除，原因是其数据源 `metadata._cumulativeTokens` 全库只有类型声明（`workunit.service.ts:32`）和读者，**无写入方**，tokens 恒 0。
- **数据其实存在**：agent-loop 每次执行已写 `workunit:tokens` 事件（`agent-loop.ts:886-905`，含 executionTokens）。
- **修法**：agent-loop `recordResult` 时把本次 `executionTokens` 累加写回 workunit `metadata._cumulativeTokens`（与 `knowledgeExtractedAt` 同路径原子写入）；此后如需告警再恢复 probe——恢复时一并修旧代码的告警 source 误标（token 预算曾标为 `'total_time'`，会被 Triage 误判为 execution_timeout）。
- **验收**：活跃 WorkUnit 的 metadata 出现真实累计值；恢复 probe 后超阈值（WARN 500K / CRIT 1M）告警可达 Triage，source 标记正确。

## 执行顺序与注意

- ②③互独立，都改 `knowledge-service.ts` 邻近区域，建议同批但分 commit；④改 agent-loop，独立进行。
- 每项都先补"生产形状"的失败测试再修（本批三个 bug 共同教训：测试 mock 形状 ≠ 生产数据形状时测试会撒谎）。
- ②修完后注入内容变多，可能触发 ③ 的裁剪——所以 ③ 最好与 ② 同批上，否则注入量不可控。
