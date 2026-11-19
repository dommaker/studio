# #703 用 merge receipt 定义代码 WU 完成

## 目标与边界

- 有 worktree 的代码 WU 评审通过后保持 `in_review`，merge 与目标验证接受后才写 `done/completedAt`。
- TDD 公开接缝：`WorkUnitService.reviewPassed()` + `waitForReviewPassSettled()`、PMO `summarizeEvidence()`、共享 `deriveDisplayState()`、`workunit.status_changed` 学习钩子。
- 无目标验证命令记 `verification.status='unavailable'`：不得自动写 L1 通过；已有 L3 可在 merge 后完成，仅 L2 则等待人工 L3。
- 本票仅持久化 WU `mergeIntent/mergeReceipt`；跨进程串行与崩溃恢复归 #704，通用 Effect/Receipt 归 #707。
- 无 worktree 的 legacy 代码 WU 保留完成兼容，但不伪造 receipt；PMO 不可交付并计 `doneWithoutReceipt`。

## 数据与状态

- `mergeIntent`：稳定 id、`queued|running`、时间戳、source/target branch。
- `mergeReceipt`：同 intent id、真实 merge 结果、目标分支/commit、目标验证 `passed|failed|unavailable` 和失败详情。
- merge 成功先落 receipt 再验证；验证失败转 blocked 但保留 merged 事实，派生 `merged-with-failed-verification`，不标 merge conflict。
- queued/running 重复通过幂等；拒绝和直接状态迁移不得绕过在途 merge/receipt 守卫。
- `mergedAt/mergeCommit` 作兼容镜像；REST metadata 禁写 merge 证据字段。

## 实施步骤

1. 共享派生：RED/GREEN 覆盖 queued/running、merged-with-failed-verification、unavailable±L3；扩展 `DerivedWuState.delivery` 和共享文案。
2. 延迟完成主链：在 `merge-on-review-pass.test.ts` 固定 running/成功/失败/unavailable，改 `workunit-review.ts`、`workunit-lifecycle.ts`、`workunit.types.ts`。
3. 真实 receipt：merge 后先落真实 commit/receipt，再目标验证；passed 或 unavailable+L3 才完成并清理 worktree/branch，失败保留真实 Git 情况。
4. 事件幂等：status 事件 additive 携带 `previousStatus`；学习钩子只响应真实进入 done；review dispatcher、inbox、suggestions 排除 merge 进度事件。
5. PMO/监控：代码证据强制有效 receipt，新增 merge/verification 缺口；ops 增加 `mergeDivergence/doneWithoutReceipt`。
6. Web：各页面复用共享 delivery；merge 中禁止重复通过/拒绝；证据台账、DeliveryPanel、监控展示新事实。
7. 更新相关 CONTEXT，运行受影响测试、changed tests、typecheck 和两轴 code review，提交当前 master 并回写 issue。
