# #712 补齐 transcript 完整性和消费者水位

## 目标

- Assignment 的 transcript 按 step 顺序记录稳定 contentId，并以 terminal 记录区分可提交、失败与仍在写入的内容。
- 恢复、角色记忆提取和 Skill 使用扫描只读取 committed 内容；处理失败不推进各自水位，重启后可续读。
- AgentLoop 在 completion 事件前完成可重试的归档对账；迟到 Assignment 仍不得写 transcript。

## 已确认测试接缝

1. `transcript-archive.ts` 公共接口：追加、终止、committed-prefix 读取、独立 consumer watermark、写入失败后的对账恢复。
2. `AgentLoop.agentStep()/recordResult()`：落盘结果真实反映在 StepRecord/Assignment，终止记录先于完成事件，fencing 不变。
3. `loadRecoveryPacket()`、`WuCompletionExtractor.maybeExtract()`、`SkillUsageScanner.scan()`：只消费 committed 内容，失败后重试，重启续扫不重复推进。

## 持久化设计

- 继续复用 `transcripts/<workUnitId>.jsonl`，不新增数据目录或第二真源。文件内 additive 增加 terminal 与 consumer watermark 记录；旧的无 kind 步骤按历史已提交记录读取。
- step 的 contentId 由 WU/Assignment/step/rawOutput 等内容哈希派生；重试追加在读侧去重。terminal 记录 succeeded/waiting/failed/superseded/cancelled，只有 succeeded/waiting 段进入默认 committed 读口。
- consumer watermark 记录 `consumer + throughContentId`，仅在 consumer callback 成功后追加。读取方找不到历史锚点时 fail-open 到已提交内容重放，依赖既有下游幂等，绝不静默漏读。
- `reconcileTranscriptAssignments` 按 WorkUnit 当前快照补写缺失 terminal；StepRecord 引用或 Assignment 聚合计数证明步骤缺失时写 failed terminal，不把残缺内容提交为成功。
- consumer 处理与 watermark 采用 at-least-once 语义；角色记忆以成功后哨兵、Skill 聚合以既有 `(skill, WU)` 去重吸收正常重试。跨文件副作用成功后崩溃仍允许重放，不宣称 exactly-once。

## RED → GREEN 切片

1. **committed prefix**：先写未完成段不可见、succeeded/waiting 可见、failed 不可见、contentId/顺序/去重 RED；实现最小投影。
2. **独立水位与恢复**：两个 consumer 独立续读，callback 失败不推进；缺 terminal 可经 Assignment 对账恢复，缺失步骤不提交。
3. **AgentLoop 时序**：append 改 await，记录真实 transcriptRecorded；recordResult 在原子簿记后、完成事件前对账，迟到结果不落 terminal。
4. **消费者接线**：恢复包过滤未提交的本模块 transcript 引用；角色记忆和 Skill 扫描切到独立 consumer，失败保留重试并增加启动续扫。
5. **文档与验证**：更新 transcripts/agent-loop/workunit/role-memory/skills CONTEXT 与数据目录契约的 JSONL 记录说明；跑定向测试、受影响测试、typecheck、code-review，提交当前 master 并回写 #712。

## 非目标

- 不把完整 transcript 注入恢复 prompt，不新增 REST 写口或数据库。
- 不改 Skill/角色记忆下游存储事务，不宣称外部副作用 exactly-once。
- 不迁移或重写旧 transcript；旧步骤保持兼容可读。
