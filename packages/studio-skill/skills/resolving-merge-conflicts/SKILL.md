---
name: resolving-merge-conflicts
description: "在 studio 自动合并（review 通过后的 task 分支合并）冲突现场解 merge/rebase 冲突：保留双方意图、跑项目验证命令全绿、完成合并，永不 --abort。"
agentTypes: [implement]
triggers: [合并冲突, 解冲突, merge conflict, resolve merge conflict, rebase 冲突, 自动合并失败, merge-on-review-pass]
status: published
---

# 解合并冲突（studio 自动合并现场）

你在一个**进行中的 merge/rebase 冲突现场**工作。工作目录（cwd）由调用方传入，是合并目标目录（baseRepo 或 PMO 集成 worktree），不是任务 worktree。prompt 会附带 mergeContext：cwd、冲突文件清单、目标分支、来源分支、当前是 merge 还是 rebase 阶段。

## 流程

1. **看现状**：`git status`、`git log --oneline -5`（双方分支）、逐个读冲突文件的冲突块（`<<<<<<<` / `=======` / `>>>>>>>`）。

2. **找一手来源**：理解每一处冲突两边各自为什么这样改、原意图是什么。读相关 commit message（`git log` / `git show`），来源分支是 `task/<wuId>`，任务上下文（WU scope）在 prompt 里。

3. **逐个 hunk 解**：能兼容就同时保留双方意图；不兼容时选与本次合并目标一致的一方，并在 commit message 里记取舍。**不发明新行为**——只裁决已有改动，不乘机重构、不顺手"优化"。**永远解完，永不 `--abort`**——abort 会销毁现场并把工单打回人工。

4. **跑项目验证命令**：prompt 会给出验证命令清单（来源：WU metadata.verifyCommands 覆盖 > 目标目录 package.json scripts 惯例：typecheck → test → lint，按 lockfile 选 pnpm/npm）。在冲突 cwd 依次跑，**全绿才算完成**；有红就修到绿（修的是合并引入的问题，不是既有债务）。

5. **完成合并**：`git add` 所有已解文件后 commit（merge 场景）；rebase 场景 `git rebase --continue` 直到全部 commit 落完。结束前 `git status` 确认无残留冲突标记、无未合路径。

## 输出

结束时用简短文字汇报：解了哪些文件、关键取舍（如有）、验证命令结果（跑了哪几条、是否全绿）。这段汇报会落进 WU metadata.mergeResolution 审计。
