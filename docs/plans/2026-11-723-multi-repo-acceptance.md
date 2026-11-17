# #723 多仓全链路验收

## 目标与已确认测试边界

沿用 #698 Testing Decisions 的预约定 seam：通过现有 HTTP/API 用户操作驱动真实 API 子进程，以临时 Studio 数据根、两个真实临时 Git 仓库和 fake provider CLI 观察持久状态、频道消息、Git 结果、恢复上下文和知识结果；不直接调用内部 Mandate、Assignment、Effect 或私有 helper。

覆盖 PMO 创建与发布、规划 NEED_INPUT 回复、TASK 分腿确认、实现 WU 隔离执行、CLI session 丢失、进程重启与外部副作用恢复、评审后合并完成、PMO 候选整体评审、逐腿 branch-only 交付和知识回流。保留并运行公开契约、旧数据迁移、模块依赖方向、数据目录契约及相关回归测试。

## 实施步骤

1. 新增聚焦的 multi-repo e2e 与可脚本化 fake CLI：先让首个用户流程切片失败，再最小实现 fixture/验收驱动，逐段扩展到完整流程。
2. 用两个临时仓库的真实分支、worktree、merge commit 和交付回执断言分腿与完成语义；通过 API 状态、频道和知识读面验证恢复与学习，不读取内部存储代替用户观察。
3. 在关键副作用后重启 API，并让 fake CLI 使 session resume 失效，验证同一工作可恢复且外部消息、评审 WU、Git 合并不重复。
4. 运行新 e2e、直接相关单测/契约/迁移/依赖检查、`vitest run --changed origin/master` 和 `pnpm typecheck`；全量套件与真实 provider/远端推送留给 CI 或明确列为未运行。
5. 更新涉及模块 CONTEXT（仅在实际公共行为变化时），执行 `/code-review` 双轴审查，修正发现后提交当前 master。
6. 在 #723 回写最终验收报告，逐项列出实际运行命令与结果、未运行项和已知限制；关闭 issue 并按父 map frontier 提示后续工作。

## 非目标

- 不修改产品语义来迎合验收；发现产品缺陷时先报告根因与修复方案。
- 不调用真实 LLM、不 push、不建远端 PR，不承诺跨仓原子交付或 exactly-once 外部执行。
- 不以局部单测替代整链 e2e，不把内部物理存储布局变成新的公开测试面。
