---
status: active
---

# #708 将 Git 合并接入持久 Effect

## 目标与边界

- 复用 #703 的 `mergeIntent/mergeReceipt/mergeCleanedAt` 领域真相与 #704 的腿级锁、真实 Git 对账，只增加 #707 Effect/Receipt 执行外壳。
- `reviewPassed()` 将 merge intent 与 merge Effect 放入同一 WU 快照提交，提交后执行；启动与周期恢复由持久 Effect 驱动，旧 WU 懒补建 Effect。
- Git 已合并但领域 receipt 缺失时，恢复及同进程重试先核查真实历史并补记，不再次产生 merge commit。
- 领域 receipt/done 已持久化后才清理；清理失败留待恢复。验证失败保留 merged/commit，不清理。
- 执行前重验 active Mandate，腿锁内继续 fresh 重验 scope/leg。
- 不新增 Effect 存储、HTTP 写口、第二套合并状态或数据目录；仅 additive 扩展 Effect kind，无新 schema 迁移。

## 已确认测试接缝

1. `WorkUnitService.reviewPassed()` + `waitForReviewPassSettled()`：同事务意图、正常/失败重试、unavailable 后人工 L3 与清理。
2. `recoverWorktreeMerges()`：重启恢复、旧数据补建、真实 Git 对账与幂等清理。
3. `WorkUnitService.getById()` / 只读 Effect 投影：Effect/Receipt、既有 mergeReceipt 与最终状态。
4. `ReviewDispatcher.recoverEffects()`：只消费 review-dispatch，不串扰 merge Effect。
5. `MandateService.revoke()` 经上述公共入口观察 queued 取消、running/迟到 Effect 执行前重验。

## 实施步骤

1. 以 merge Effect 持久化与正常执行为首个纵切，再依次覆盖崩溃/重试、清理/验证、授权/恢复隔离，每个纵切先 RED 后 GREEN。
2. additive 扩展 shared/contract Effect kind；在 WorkUnit review 统一提交中附 merge Effect，经 `EffectService` 执行现有合并机。
3. Effect adapter 将恢复与重试都接到真实 Git 对账；lock-busy/存储异常进入有限重试，领域终局不盲目重放。
4. 清理失败显式留待恢复；deferred cleanup 使用稳定 Effect 幂等键；恢复入口为旧数据补建意图并只消费 merge kind。
5. ReviewDispatcher 恢复只消费 review-dispatch；同步数据目录契约与模块 CONTEXT。
6. 运行定向测试、typecheck、受影响测试和双轴 code-review；测试与实现分别提交，实现 commit 引用测试 commit。
