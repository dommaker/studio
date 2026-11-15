# #714 为续用会话提供增量上下文

## 目标

- 新 CLI session 始终得到完整的目的特定快照；只有同一真实 CLI session 的续用步才可省略未变化段。
- 以最终截断后正文的 SHA-256 作为 section revision；Assignment 持久化已呈现游标，linked Assignment 仅在真实 CLI session 一致时继承。
- base 中的人类输入、一次性 hint 与产出契约始终保留；换 session（含上下文溢出重试）从空游标开始。
- `STUDIO_INCREMENTAL_CONTEXT=true` 时启用 delta，默认保留 full 基线；按 full/delta 对照重复 token、溢出、恢复、人类恢复后输入与执行质量，质量未回归才具备扩大启用条件。

## 已确认测试接缝

- `composeStepPrompt`：验证 full → unchanged delta → changed revision，及新人类输入/产出契约不丢。
- `AgentStep + ExecutionJournal`：验证成功步落游标、NEED_INPUT linked Assignment 同真实 CLI session 继承、session replacement 重置。
- 既有 `runStepRetry` 接缝：验证 overflow 虽不回放旧 handoff，仍按新会话重组完整快照。
- 既有 `/efficiency` 聚合接缝：验证 full/delta 对照指标与质量回归门。

## 实施步骤

1. 在 `prompt-composer.test.ts` 写 full/delta RED；在 composer 的 `runSection` 统一计算 revision、省略未变段并返回下一游标与上下文度量，contract/base/hint 不参与省略。
2. 给 `AssignmentRecord` 增加内部 `presentedContext`，在 loop 组装前解析当前/上一 linked Assignment 的同 CLI session 游标；成功结果经 `ExecutionJournal.recordStepResult` 原子落游标和真实 `cliSessionId`，失败步不推进。
3. 重试重算返回完整 composed 结果；替换 session 时不传旧游标，并同步替换 prompt 与 knowledgeContext。overflow 继续以 `isNewSession=false` 避免重复 handoff，但空游标保证 full snapshot。
4. 将上下文 mode/重复 token/人类输入附加到既有执行步事件，在 `/efficiency` 增加 full/delta 对照聚合；delta 成功率或完成率低于 full 时 `qualityNotRegressed=false`，不自动扩大开关。
5. 更新 agent-loop/workunit/ops CONTEXT，运行相关单文件测试、受影响测试与 typecheck，再执行 code-review。

## 非目标

- 不改变公开 AssignmentSummary、REST WU 形状、九段预算或产出契约模板。
- 不注入完整 transcript，不自动根据指标切换环境开关，不新增监控 UI。
