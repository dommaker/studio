# #719 闭合约束进化的生效后治理

来源：studio#719（父单 #698），前置 #715 已完成。

## 已确认测试 seam

- `EvolutionService.runScan(repoRoot)` / `decide()` / `settleObservations()`：显式目标仓库、审批后观察记录、前后指标、keep/rollback 终态及关联知识更新。
- `applyProposal()`：目标文件写后验证、可恢复备份、role preset 默认仅影响未来 profile、显式 `targetProfileIds` 的既有 AgentProfile 更新。

不新增 REST 面，不测试私有 helper。

## 持久化与行为契约

- `EvolutionProposalData` 增加 `targetRepo` 与可选 `targetProfileIds`；新提案始终记录本轮显式选择的仓库。旧提案缺 `targetRepo` 时拒绝生效，不回退 `process.cwd()`。
- 生效成功后在原提案 JSON 内记录 `observation`：目标 revision、前后内容 hash、观察起止时间与窗口、前后指标、最终 `keep | rollback` 裁决和恢复结果。
- 每次日扫描先结算到期观察；指标沿用现有 traces/outcomes，按 targetType 计算失败率。后窗失败率不高于前窗则 keep，否则 rollback；零后窗样本作为“未观察到退化”保留并记录样本数。
- rollback 恢复目标文件（原不存在则删除）及显式更新的 AgentProfile，做恢复后 hash/内容验证；retire 产生的关联知识条目转 archived，避免回退后仍被当作有效经验。
- 所有配置写路径继续要求人审；prompt override 补写后读回验证。role preset 不改既有 AgentProfile，除非提案明确列出 `targetProfileIds` 并经过同一审批。

## RED → GREEN 切片

1. **显式目标仓库**：`runScan` 无 repoRoot 时 RED；实现必填目标并写入提案，`decide` 从提案目标解析生效路径，生产 handler 遍历 PMO 显式绑定仓库。
2. **角色对象边界**：applier 默认不改 profile、显式目标才更新且读回验证的 RED；实现 profile 快照与更新/恢复。
3. **生效观察记录**：approve 后缺少 revision/hash/window/before metrics 的 RED；实现 ApplyResult 元数据和 observation 持久化，prompt 写后验证补齐。
4. **观察裁决与回退**：到期后改善/不恶化 keep、恶化 rollback 的 RED；实现指标快照、恢复、知识归档和事件。
5. 更新 evolution / agents 相关 CONTEXT，运行单文件测试、受影响测试与 typecheck，随后 code-review 并提交当前 master。

## 非目标

- 不新增进化 HTTP/UI 管理面。
- 不引入新调度框架或第二份提案存储。
- 不自动修改未显式点名的 AgentProfile，不迁移缺少目标仓库的历史提案。
