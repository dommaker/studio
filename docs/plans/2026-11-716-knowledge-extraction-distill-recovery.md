# #716 知识提取与蒸馏恢复

## 目标

让知识提取与蒸馏具备持久、可重试、可观测的执行状态；只有派生产物可恢复发布后才归档原料；接通真实 session summary 生产链，退役伪会话摘要与无人调用的 decision-chain 提取。

## 已确认测试边界

- AgentLoop 完成记录 + `EffectService`：提取触发、成功、失败与重启恢复。
- 蒸馏审批执行 + `DistillRunsStore`：状态机、重试、派生产物恢复与原料归档。
- session summary 生成器：真实事件触发、持久去重与失败恢复。
- `/monitoring/overview` 聚合：知识发布失败、重试和卡住状态只读投影。

## 实施步骤

1. **提取恢复**
   - 为知识提取增加 `Effect/Receipt` kind 与适配器，使用 WU/Assignment/StepRecord 稳定幂等身份。
   - 移除完成阶段的 `knowledgeExtractedAt` 提前成功标记；通过 committed transcript 消费水位读取输入。
   - 让模型、存储、提案失败向上传播；临时失败进入 `retry-after`，成功后才推进水位并写 Receipt。
   - 启动时恢复 queued/running/needs-reconciliation，并补扫已完成 WU 的未消费 transcript。

2. **蒸馏恢复与归档**
   - 在既有 `runs.jsonl` 上增加 `triggered/running/succeeded/failed/retry-after`、尝试次数、下次尝试时间与错误信息，兼容 legacy `executed/failed`。
   - 审批执行先持久化 run 和恢复清单，再执行模型与产物落地；临时失败保留 pending 并调度重试，启动恢复未完成 run。
   - 为派生产物记录稳定身份和可恢复发布状态；所有产物 durable 后才归档完整原料清单，最后写 succeeded 并推进消费基线。
   - 恢复时认养已落地产物，不重复生成；`card-failed` 可重新发卡，不作为成功。

3. **休眠生产链**
   - 接通 `events/session-summary-generator` 的真实 `session:end` 恢复扫描，按 session 持久去重，失败留待下轮。
   - 退役 Git commit 伪 session summary 的启动调度、导出与实现。
   - 退役无生产调用方的 decision-chain 提取/手工记录面，保留既有 decision 查询和历史数据。

4. **运营只读投影**
   - 在现有 monitoring overview 增加知识提取与蒸馏的 by-state、retry/failure/card-failure、stale-running 计数和薄异常项。
   - 更新 contract schema；不新增第二套存储或 Effect HTTP 写口。

5. **文档与验证**
   - 更新相关 `CONTEXT.md`、能力说明和数据目录契约。
   - 每个行为片先跑 RED 再实现 GREEN；开发中反复跑单文件测试和 typecheck。
   - 收尾运行受影响测试、`pnpm typecheck`、code-review，再提交当前 master 并关闭 #716。

## 明确不做

- 不实现 #717 的 Skill 发布/注入质量门，也不实现 #718 的角色记忆效果生命周期。
- 不重写 #712 transcript 或 #715 学习元模型。
- 不运行全量测试，不部署、不 push。
