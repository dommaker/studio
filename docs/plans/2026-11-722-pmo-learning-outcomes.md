# 整体评审与最终交付结果回写知识（#722）

## 目标与边界

PMO 候选整体评审拒绝或 auto-merge 真实交付失败后，沿受影响 WU 及其知识派生链追加统一 learning outcome/revision；失败经验保留可浏览，但既有 `proven` 降为 `verified`，后续也不得凭早期 WU 成功重新获得 `proven`。重复事件、部分写入后的恢复和重启恢复均不得重复追加或反转终局结果。

本票只接 auto-merge 的 `no-repo`、`checkout-mismatch`、`conflict`。branch-only 没有系统外交付失败上报入口，`not-ready`、`merge-pending`、门禁/授权拒绝和重复落档均不视为真实交付失败，不新增 HTTP 写口。

## 已确认测试 seam

1. 知识终局回写公共函数：WU 与 `sourceReferences[].entryId` 派生闭包、revision/sourceReference 追加、失败标签、`proven→verified`、重复 eventId 幂等。
2. 真实 FileStore `Effect/Receipt`：同键触发、即时执行、部分写入后恢复及重启恢复不重复。
3. `CandidateReviewService.performResult()`：当前候选拒绝触发受影响项目 WU 回写，重复/陈旧结果不重复触发。
4. `deliverProject()`：单腿真实合并失败回写项目 WU；多腿仅回写失败腿与 shared WU，门禁拒绝不误报。

## 实施步骤

1. **知识回写 RED→GREEN**
   - 新增 `learning-outcomes.ts`，基于现有 `getLearningMetadata()` / `LearningOutcome` 扫描含 archived 的知识条目。
   - 先按任一来源匹配受影响 WU，再沿 `sourceReferences[].entryId` 求派生闭包；以受影响 WU 的 learning 为 provenance、全局最新 revision+1 追加稳定 `outcomeEventId`。
   - 评审拒绝写 `verification=failed`、`delivery=unmerged`；交付失败保留 execution/verification、写 `delivery=unmerged`。统一添加去重失败标签并将 `proven` 降为 `verified`，其余 maturity 保持不变；终局失败不被迟到 WU 成功来源反转，成功 Effect 在迟到提取后对账补标新条目。

2. **持久 Effect RED→GREEN**
   - 新增 `knowledge-outcome` Effect 适配器，payload 持久化 eventId、kind、受影响 WU ids；以项目内稳定 WU 为锚点。
   - 复用 `EffectService` 的同键去重、有限重试和启动恢复；条目级 eventId 让知识已写但 Receipt 未写的崩溃续跑保持幂等。
   - additive 扩展 shared/contract Effect kind，按现有数据区迁移惯例抬 schema 版本，并在 bootstrap 装配恢复。

3. **PMO 两个入口接线**
   - `performResult()` 仅在当前候选成功落为 rejected 后，以 project+candidate 稳定 eventId 触发；受影响 WU 使用现有项目证据归属口径，排除整体评审 WU。
   - `deliverProject()` 仅在实际 Git 交付失败后触发；多腿按现有 `partitionSnapshotsByLeg()` 选择失败腿及 shared WU。eventId 包含项目、失败原因、腿、源 head/失败明细和受影响 WU 指纹，避免不同候选失败事件互相覆盖。

4. **文档与验证**
   - 更新 knowledge/pmo/workunit、shared/contract/bootstrap 相关 CONTEXT 与数据目录契约，只记录真实新增行为。
   - 每个行为片先跑 RED 再实现 GREEN；开发中反复跑相关单文件测试和 `pnpm typecheck`。
   - 收尾运行 `pnpm exec vitest run --changed origin/master`、新鲜 typecheck 和 `/code-review`，修复评审发现后提交当前 master，不 push、不部署。

## 非目标

- 不建立第二套 outcome/maturity 状态，不扩展 `KnowledgeService` 兼容 facade，不把消费事件 `recordOutcome()` 改作知识回写。
- 不回写 Skill 或角色记忆，不归档失败经验，不添加 `low_quality` 标签。
- 不回写 auto-merge 尚未执行交付的门禁失败，不处理 branch-only 系统外失败，不改交付/评审现有状态机。
