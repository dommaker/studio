# #711 用结构化 StepRecord 生成恢复包

## 目标

- 每个有 Assignment 的执行结果追加 typed StepRecord，记录动作、AC 进展、修改文件、命令、验证、决策、产物、结果、下一步和 transcript 引用。
- 新会话使用由 Mandate、StepRecord、当前 WU 事实和实时 Git 状态生成的恢复包，不再只依赖滚动短摘要。
- 恢复包保留 AC 状态、已记录决策、未完成事项、最近验证、待回答问题与按需 transcript 引用，并继续走 handoff 段 token 预算。

## 已确认测试接缝

1. `ExecutionJournal.recordStepResult`：StepRecord 与 Assignment 同事务持久化，迟到结果仍被 fencing。
2. `recovery.ts`：从结构化记录与当前快照构建恢复包；真实临时 Git 仓库验证 branch/commit/dirty 在恢复时重读。
3. `prompt-section-handoff.ts`：新会话渲染恢复包，不读取 sessionSummary/progressLog 作为外部现状，超预算仍截断。
4. `agent-loop-parsers.ts` / 执行段：解析可选 `STEP_RECORD:` JSON，并从工具事件补充真实命令、修改文件与 transcript 引用。

## 实施步骤

1. 先写 StepRecord 持久化与恢复包 RED；在 shared snapshot 增加 typed 记录，ExecutionJournal 在现有锁内追加。
2. 实现恢复包纯派生和实时 Git 读取；Git 失败保留 unknown/null，不把旧摘要冒充当前状态。
3. 将 handoff 新会话段切换到恢复包，保留无 StepRecord 旧单的兼容回退和既有 token 截断/度量。
4. 增加 `STEP_RECORD:` 可选输出协议与工具事件派生，执行成功时填充完整记录和 transcript 定位引用。
5. 更新 workunit/agent-loop CONTEXT；运行相关单文件测试、受影响测试、typecheck，随后 code-review 并提交当前 master。

## 非目标

- 不把完整 transcript 塞回 prompt，不新建数据库或第二套会话状态。
- 不在恢复时自动重跑测试；最近验证来自当前持久事实，Git branch/commit/dirty 必须实时读取。
- 不改公开 REST 写口，不允许客户端直接写 StepRecord 或恢复包。
