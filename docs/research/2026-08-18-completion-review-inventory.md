# 「完成判定」与 review 链路现状盘点（wayfinder #232）

> 研究票：#232（地图 #85「agent 执行质量：评估与改进」）。只产事实，不产决策。证据精确到 文件:行号。
> 盘点基线：master @ c4f0b8ff。

## 完成判定现状

### 0. 两条执行路径（前提事实）

`packages/studio-agent` 内有两条执行路径，完成判定逻辑不同：

- **多 session 循环** `executeSessionLoop()` — `packages/studio-agent/src/services/runner-execution.ts:58`，门面 `AgentRunner.execute()`（`packages/studio-agent/src/agent-runner.ts:77-79`）
- **轻量单 session** `executeLightweightSession()` — `packages/studio-agent/src/services/runner-lightweight.ts:51`，门面 `AgentRunner.executeLightweight()`（`packages/studio-agent/src/agent-runner.ts:81-83`）

生产调用方只有后者：agent-loop 经 `LocalExecutor` 原样委托 `agentRunner.executeLightweight`（`apps/api/src/modules/agents/loop/executor.ts:22-24`；调用点 `apps/api/src/modules/agents/loop/agent-loop.ts:983`）。`execute()` 多 session 路径在 `apps/` 下无生产调用方，仅测试与 legacy SDD 文档引用。

### 1. agent 报「完成」的依据

**多 session 路径：依据回写文件，不看 CLI 输出文本。**

- agent 被 prompt 指示在 worktree 写 `.progress.json`（`packages/studio-agent/src/services/runner-params.ts:184,194-195`：读 .progress.json、每完成一步更新、全部完成设 `allComplete: true`）
- 判定函数 `readProgress()` 读 `<worktree>/.progress.json`，解析失败返回 `null`（`packages/studio-agent/src/services/output-capture.ts:32-39`）；结构 `ProgressReport`（`allComplete`/`completedSteps`/`testResults`）在 `output-capture.ts:18-27`
- 成功条件（`runner-execution.ts:394`）：`latest?.allComplete && (latest.testResults?.failed === 0 || failed == null)`——纯靠 agent 自报的进度文件，`testResults` 数字同为自报，包内不独立跑测试

**轻量路径（生产路径）：依据 exit code + stream-json result 事件，不读任何回写文件。**

- `execSh` 仅在子进程 `close` 事件 `code === 0` 时 resolve（`packages/studio-shared/src/utils/process-io.ts:221-222`）；非零 exit/信号 reject（`:223-230`），超时 reject（`:189-197`）
- resolve 后解析 stream-json，`extractResult()` 取 `type==='result'` 事件的 `is_error` 与 `result` 文本（`packages/studio-shared/src/llm/stream-json-parser.ts:128-145`）
- 分支：`isError` → `success:false`（`runner-lightweight.ts:161-170`）；否则 → `success:true`（`:172-182`）
- agent 的语义级「完成」信号（尾行 `ACTION: COMPLETE`）不在包内判定，由上层 `parseAgentOutput` 解析（`apps/api/src/modules/agents/loop/agent-loop-parsers.ts:60-81`；调用点 `agent-loop.ts:1120`）；无 ACTION 行默认按 `progress`（`agent-loop-parsers.ts:80`）

session:start/end 事件只是记录（写 `~/.studio/logs/studio-events.jsonl`，`output-capture.ts:145-176`），不是判定依据。

### 2. session loop 判定逻辑（多 session 路径）

核心循环：`runner-execution.ts:173` `while (sessionCount < config.maxSessions)`，`maxSessions` 默认 5（`agent-runner.ts:47,68`）。每 session：`execSh` spawn `bash -c`（`process-io.ts:75`），timeout 默认 30min（`runner-execution.ts:258`），maxBuffer 10MB（`:259`）。分支：

- **exec 抛错**（非零 exit / 超时 SIGTERM / 信号 / 超 maxBuffer）→ catch 块 `runner-execution.ts:294`：`recordExecutionError`（已废弃，仅 warn 不落库，`output-capture.ts:212-224`）→ 补发 session:end（`:315`）→ RKB 已知解法查询注入下轮 prompt（`runner-output.ts:223-261`）→ 若 `sessionCount >= maxSessions` 返回 `success:false`（`:354-359`），否则 `continue` 重试（`:361`）
- **exec 成功但 `isError`** → 仅 warn 不判失败，继续走进度判定（`:291-293`）
- **Session 1 零进展 fast-fail**：completedSteps 空 且 无 testResults 且 `!allComplete` → 立即 `success:false`（`:372-392`）
- **成功**：`:394-413`，`collectOutputFiles()` 收集 worktree 根目录 `.md`/`.json`（`output-capture.ts:44-57`）
- **Stuck fast-fail**：session 后 `completedSteps` 未增长且 `!allComplete`（`:417-418`）；若 worktree 3 分钟内有文件活动（`hasRecentActivity`，`runner-output.ts:138-206`）则延期，否则 `stuckCount++`；`stuckCount >= 1` 即 `success:false`（`:427-460`，一次无进展就失败）
- **maxSessions 耗尽未完成**：`:463-491` 返回 `success:false`
- 超时杀进程细节：execution 路径超时仅 `SIGTERM` 直接子进程（`process-io.ts:189-197`）；lightweight 路径开 `killProcessGroup`（杀整组 SIGKILL）+ 可选静默看门狗 `silenceKillMs`（`runner-lightweight.ts:140-145`；看门狗实现 `process-io.ts:117-137`）

轻量路径无重试、无 stuck 检测、无进度文件：单发 spawn，exit 0 且 `!is_error` 即 `success:true`（`runner-lightweight.ts:176-182`），失败即返回（`:161-170,196-202`）。

### 3. 产出物校验现状

**包内（packages/studio-agent）：无实质校验。**

- `collectOutputFiles` 只列文件名不验内容（`output-capture.ts:44-57`）
- `.progress.json` 解析失败 → `readProgress` 返回 `null` → 按「未完成」处理（`output-capture.ts:36-38`），无 schema 校验
- 轻量路径 `outputFiles` 恒为 `[]`（`runner-lightweight.ts:177`），不检查回写文件是否存在、不校验 `outputText` 结构
- `recordExecutionError` 已退化为空操作（`output-capture.ts:212-224`，注释标注 DEPRECATED）

**下游 agent-loop 层有守卫（包外）：**

- COMPLETE 收口守卫链 `runCompletionGuards`（`agent-loop.ts:1416` → `apps/api/src/modules/agents/loop/completion-gates.ts:402-524`）：提交守卫 `hasUncommittedChanges`（`completion-gates.ts:29-36,425-451`）、L1 自动验证守卫 `runWuVerification`——实际执行验证命令（override：`metadata.verifyCommands`；约定：worktree `package.json` 的 test/typecheck/lint scripts，`apps/api/src/modules/agents/loop/wu-verification.ts:49-70`）
- 输出协议解析：尾行 `ACTION: PROGRESS|COMPLETE|NEED_INPUT|DELEGATE`（`agent-loop-parsers.ts:65-77`）
- review WU 的 `REVIEW_RESULT` JSON 解析，失败不写 `metadata.reviewReport`，由 ReviewDispatcher 转人工（`agent-loop.ts:1200-1207`；`agent-loop-parsers.ts:104-131`）

### 4. checkSessionTruncation / extractInputTokens 残留确认

全仓 grep：生产代码 **0 引用**（这两个符号历史上属 `apps/api` agent-loop 域，非 packages/studio-agent）。残留位置：

- `.studio/legacy-sdd/session-per-wu-resume/design.md:51`（历史设计文档）
- `.studio/legacy-sdd/session-per-wu-resume/requirement.md:28`（历史需求文档）
- `.studio/CONTEXT.md:118`（模块上下文历史记录，明确记载「SESSION_TOKEN_LIMIT/checkSessionTruncation 观测防线整体删除」）
- `apps/api/src/modules/agents/__tests__/agent-loop.test.ts:567`（注释引用）
- `apps/api/src/modules/agents/__tests__/agent-loop-step-timeout.test.ts:6,180-189`（守删测试：断言模块不再导出 `extractInputTokens`——属预期保留的防护测试）

### 5. 结果/回写数据流向（包内落点 → agent-loop 消费）

- 原始 stdout → `<worktree>/.agent.log`（`runner-output.ts:76`）
- stream-json 解析后 → `~/.studio/logs/studio-events.jsonl`：`agent_session` 指标（`output-capture.ts:105-127`）、session:start/end、per-tool `tool:call`（`:181-191`）、`file:change`（`:196-206`）
- `ExecutionResult`（含 `outputText`/`rawOutput`/`usage`/`sessionIds`）返回调用方（`packages/studio-agent/src/types.ts:89-118`）
- agent-loop 消费：`agent-loop.ts:983` 执行 → `success:false` 走 failed/need_input 分支（`:991-1112`，含 #94 续用降级重试 `:1009`、#96 上下文溢出重试 `:1054`）→ `outputText` 经 `parseAgentOutput` → `recordResult` 守卫链与状态迁移（`:1390-,1416`）；`rawOutput` 落工具事件/transcript/SSE（`:1140-1172`）；`usage` 记账（`:1129,1004-1005`）；review/analysis 结构化产出写 `metadata.reviewReport`/`analysisTasks`（`:1200-1237`）

## review 链路现状

### 0. 链路总图

```
unassigned WU
  │ ① AgentLoop.observe() 可见性过滤            agent-loop.ts:592-620
  │ ② claimAndAnnounce → WorkUnitCrudService.claim()
  │      agent-loop.ts:387-389 → workunit-crud.ts:416-452
  ▼ active（5min 租约 + 30s 心跳，workunit.types.ts:339）
  │ ③ AgentLoop.agentStep → LocalExecutor.execute
  │      → studio-agent executeLightweight（executor.ts:22-24）
  │ ④ parseAgentOutput：agent 自报 ACTION 行（agent-loop-parsers.ts:60-81）
  ▼
  ⑤ AgentLoop.recordResult（回写唯一入口）       agent-loop.ts:1390
     ├─ fencing：stillHoldsLease 比对 claimedAt 代际      :1400-1403
     ├─ runCompletionGuards（收口守卫链）                 completion-gates.ts:402-524
     ├─ metadata 锁内合并写 updateMetadata                :1558-1588
     └─ complete → transitionStatus(active→in_review)    :1685-1687
        （review 子 WU 再直接 in_review→done）            :1691
  ▼ in_review → eventBus 'workunit.status_changed'
  ⑥ ReviewDispatcher 路径 A（自动派 agent 评审）   review-dispatcher.ts:57
     路径 B（评审子 WU done → 父 reviewPassed/reviewRejected）:63,322-394
  ⑦ 人工入口（human-only）                        workunit.routes.ts:303-567
  ⑧ reviewPassed → 自动合并 task 分支（best-effort） workunit.service.ts:209-223
```

### 1. 结果回写入口与状态机流转

- 状态机表：`apps/api/src/modules/workunit/workunit.types.ts:274-282`（`in_review: ['done','active','closed']`）；唯一校验点 `WorkUnitService.transitionStatus`（`apps/api/src/modules/workunit/workunit.service.ts:85-98`）
- **没有独立的「回写 API」**。执行结果不经 HTTP 回写：agent（CLI 子进程）的 stdout 由 `AgentLoop.recordResult` 解析 ACTION 协议行后直接改 WU（`agent-loop.ts:1390`）。packages/studio-agent 是纯执行基础设施，全包无任何 transitionStatus/reviewPassed 调用——回写与状态迁移 100% 在 apps/api 侧 agent-loop
- COMPLETE 的迁移：`agent-loop.ts:1685-1687`（active→in_review）；review 类型子 WU 额外直接 →done（`:1691`）
- 强制收口：步骤超限（`STEP_LIMIT=15`/`REVIEW_STEP_LIMIT=30`，`:85-86`）→ 强制 in_review（`:1634-1640`）；连续 3 步无进展 → blocked（`:1643-1670`）；need_input → blocked + waitingForInput（`:1693-1701`）；L1 验证连续失败 ≥3 → blocked（`:1602-1626`）

### 2. review/Auditor 发生在哪一层

Review = 两层并存（F6 三层证据台账 l1/l2/l3，`workunit.types.ts:184-187`）：

- **L1 自动验证**：回写时守卫链内（见下 §3），仅代码类
- **L2 agent 评审（自动）**：`ReviewDispatcher`（`apps/api/src/modules/agents/loop/review-dispatcher.ts`）：
  - 订阅 `workunit.status_changed`（`:46-49`，wiring 在 `apps/api/src/index.ts:237`）
  - 路径 A：父 WU 进 in_review 且 type ∉ {review, analysis, decision, spec} → 自动建未指派 review 子 WU（`:57,165-190`），排除实现者（`excludeAssignee`，`:168,257`）；频道无其他成员时**自评兜底**（selfReview=true + 频道提醒人工复核，`:169,177-187`）
  - 路径 B：review 子 WU done → 读 `metadata.reviewReport`（评审方 loop complete 时解析 REVIEW_RESULT 行写入，`agent-loop.ts:1200-1207`）：
    - `approved` → `reviewPassed`（父 in_review→done，写 l2，`:369-371`）
    - `rejected` → `reviewRejected`（父 in_review→active，写 l2 rejected 留痕，`:389-392`）
    - 无 report / needs-info → **不默认拒绝**，频道转人工，父保持 in_review（`:336-356`）
    - 父已被人工直推 done：approved → 幂等补写 l2 不动状态（`:328-330,371`）；**迟到 reject 不打回**，只频道转人工复核（`:375-388`，注释「验收权只在人」）
- **L3 人工确认（人工）**：HTTP 端点 `POST /:id/review-passed` / `review-rejected`，agent 身份一律 403（`apps/api/src/modules/workunit/workunit.routes.ts:303-339,342-367`）。`reviewRejected` 连续 3 次 → auto-blocked（`workunit.service.ts:434-435`）
- **analysis / decision / spec 不派 agent 评审**（`review-dispatcher.ts:57`；对账扫描同口径跳过 `apps/api/src/modules/agents/dispatch-reconciliation.ts:161`），验收闸 = 纯人工 L3。analysis 进 in_review 由 `AnalysisHandoff` 提示人工确认（`apps/api/src/modules/pmo/analysis-handoff.ts:45-57,127-148`）；done 后按 TASK 拆分行派生子 WU
- **人工确认豁免口**：无频道 + trigger 来源 + 无 TASK 的巡检单**免确认直转 done**（`analysis-handoff.ts:99-110`，调 `reviewPassed` 不传 attestation——l2/l3 台账都不落）
- **reviewPassed 副作用**：自动合并 task 分支回 base/PMO 分支（`workunit.service.ts:209-223` → `apps/api/src/modules/workunit/merge-on-review-pass.ts:1-58`）；冲突 → WU 置 blocked 转人工（`workunit.service.ts:315-351`）；analysis 按类型硬旁路（`merge-on-review-pass.ts:28-30`）
- **Auditor 不在 review 链路上**：`apps/api/src/modules/agents/auditor/auditor.service.ts:20-36` 每日一次批处理，只做统计/建议/Triage 升级/eval case（`auditor-execution.ts:27-271`），**从不改任何 WU 状态**，纯事后观测

### 3. 类型匹配与产出质量校验（PMO-12 相关）

- **claim 时无 acceptedTypes 校验**。显式注释：「决策 10：认领纯显式，不再有 acceptedTypes 类型过滤（推断只用于 skill 排序，不否决路由）」`agent-loop.ts:602`。acceptedTypes 仅存于 profile，消费点仅两处：(a) prompt 组装的 skill 排序入参（`agent-loop.ts:830`）；(b) 频道默认管线第一跳建子 WU 时的 type 命名（`apps/api/src/modules/workunit/workunit-crud.ts:276`）
- claim 服务端校验只有：flock 原子认领（status≠unassigned 拒绝）+ metadata.files 文件冲突检查（`workunit-crud.ts:416-452,373-404`）；注释明确「FileStore.claimWorkUnit 不校验既有 assigneeId……可见性由 observe 保证，而非 claim 本身」（`:409-412`）。HTTP `/claim` 端点同样无类型/身份校验（`workunit.routes.ts:260-282`）
- **产出物质量/结构校验 = 仅守卫链**（`completion-gates.ts:402-524`）：
  1. 提交守卫：COMPLETE 时 worktree 有未提交改动 → 降级 progress（`:425-451`）；review WU 豁免（`:425`）；git 失败 fail-open（`:29-36`）
  2. 子任务守卫：有未完结子 WU → 降级（`:456-463`）
  3. L1 自动验证：仅 `CODE_WORKTREE_TYPES = {task,bug,feature,refactor}`（`wu-verification.ts:17`）且有 worktreePath 才跑（`:469-513`）。**analysis/review/decision/spec 永不跑 L1**
  4. 软观测（tdd-chain/phase-format/contract-presence）：**只观测不拦截**，全链路 fail-open（`:99-107,515-521`）
- COMPLETE 本身是 agent 自报（ACTION 行），产出内容（是否答了 scope 问的问题）**无任何结构/质量校验**。analysis 的 TASK:/FOG:/OPPORTUNITY: 解析失败不阻断 complete（`agent-loop.ts:1212,1231` 注释）

### 4. 各环节拦截能力矩阵

| 环节 | 能拦住 | 拦不住 |
|---|---|---|
| **claim**（observe 过滤 + claim()） | 非 unassigned 的单（flock，`workunit-crud.ts:431-434`）；显式指名给别人的单（`agent-loop.ts:603-604`）；非频道成员（`:605-613`）；被 excludeAssignee 排除的实现者（`:617`）；blockedBy 未了结（`:619`）；72h 陈旧单（`:598`）；文件冲突（`workunit-crud.ts:425-428`） | **任务类型 vs acceptedTypes 不匹配（决策 10 明确不过滤，`agent-loop.ts:602`）**；HTTP /claim 直调绕过 observe 全部可见性约束（`workunit.routes.ts:260-282`）；能力/负载匹配 |
| **执行中** | 测试特征 WU 直接关闭（`agent-loop.ts:655-669`）；每日 token 预算熔断（`:676-`）；DELEGATE 深度/宽度/环校验（`apps/api/src/modules/workunit/delegation-gate.ts:129-195`）；租约 fencing（易主后放弃回写 + 杀进程组，`:1400-1403`） | 干错方向的活（无任何「任务意图 vs 执行内容」校验）；执行质量 |
| **回写时**（recordResult 守卫链） | 未提交改动（代码类/review 豁免）；未完结子任务；代码类 L1 验证失败（降级，≥3 次 blocked） | **非代码类（analysis/review/decision/spec）的产出质量——L1 不适用**；自报 COMPLETE 但内容为空/跑题；软观测违规（明确不拦截，`completion-gates.ts:99-107`）；git 故障时守卫整体失效（fail-open） |
| **review 时**（L2 + L3） | 代码类：reviewer agent 可 reject → 打回 active（`review-dispatcher.ts:389-392`）；人可 reject（l3）；agent 身份调 review 端点被 403（`workunit.routes.ts:308-312`）；连续 3 拒 → blocked | **analysis/decision/spec 无 L2**——干错活的 analysis 任务只能等人工 L3 发现；**trigger 巡检单（无频道无 TASK）连人工闸都被豁免**（`analysis-handoff.ts:99-110`）；reviewer 输出解析失败只转人工不拦截（父留 in_review）；父已被人工直推 done 后迟到 reject 不打回（`review-dispatcher.ts:375-388`）；自评兜底场景实现者可自审（`:177-187`）；`POST /:id/status` 端点无 human-only 限制，任何认证调用方可在状态机允许范围内直推 in_review→done（`workunit.routes.ts:540-567`，无台账） |

### 5. PMO-12 场景还原

analysis 任务被 acceptedTypes=['test'] 的 agent 认领并完成，链路各层全部放行：

claim 环节按设计不过滤类型（`agent-loop.ts:602`）→ 执行中无校验 → 回写时 analysis 不跑 L1（`wu-verification.ts:17`）→ review 环节 analysis 不派 agent 评审（`review-dispatcher.ts:57`）→ 唯一拦截点 = 人工 L3 点「拒绝」（`workunit.routes.ts:342-367`）；若该单是 trigger 来源 + 无频道 + 无 TASK 的巡检单，人工闸也被豁免直转 done（`analysis-handoff.ts:91-110`）。Auditor 每日批处理只能事后统计，不拦截。

## 关键证据清单（文件:行号）

完成判定：

- 生产路径 = 轻量单 session：`apps/api/src/modules/agents/loop/executor.ts:22-24`、`agent-loop.ts:983`、`packages/studio-agent/src/services/runner-lightweight.ts:51`
- 轻量路径成功条件 = exit 0 + result 事件 `is_error=false`：`packages/studio-shared/src/utils/process-io.ts:221-222`、`packages/studio-shared/src/llm/stream-json-parser.ts:128-145`、`runner-lightweight.ts:161-182`
- 多 session 路径成功条件 = agent 自报 `.progress.json` 的 `allComplete`：`packages/studio-agent/src/services/runner-execution.ts:394`、`output-capture.ts:18-39`、`runner-params.ts:184,194-195`
- 语义级「完成」= agent 自报 `ACTION: COMPLETE` 尾行，无默认 complete：`apps/api/src/modules/agents/loop/agent-loop-parsers.ts:60-81`
- 产出物校验：包内无（`output-capture.ts:44-57`、`runner-lightweight.ts:177`）；包外守卫链 `completion-gates.ts:402-524`、L1 验证 `wu-verification.ts:17,49-70`
- 死代码残留：`apps/api/src/modules/agents/__tests__/agent-loop-step-timeout.test.ts:6,180-189`（守删测试）、`.studio/CONTEXT.md:118`、`.studio/legacy-sdd/session-per-wu-resume/{design.md:51,requirement.md:28}`、`agent-loop.test.ts:567`（注释）；生产代码 0 引用

review 链路：

- 回写唯一入口 `recordResult`：`agent-loop.ts:1390`；fencing `:1400-1403`；COMPLETE → in_review `:1685-1687`
- 状态机：`workunit.types.ts:274-282`；唯一校验点 `workunit.service.ts:85-98`
- L2 自动评审 `ReviewDispatcher`：`review-dispatcher.ts:46-57,165-190,322-394`；analysis/decision/spec 不派评审 `:57`
- L3 人工端点（agent 403）：`workunit.routes.ts:303-367`
- claim 无类型过滤（决策 10）：`agent-loop.ts:602`；claim 校验仅 flock + 文件冲突：`workunit-crud.ts:416-452`
- 巡检单免人工确认直转 done：`analysis-handoff.ts:99-110`
- 迟到 reject 不打回：`review-dispatcher.ts:375-388`；自评兜底 `:177-187`
- Auditor 不改状态：`auditor/auditor.service.ts:20-36`

## 未决疑问

1. **PMO-12 涉事 WU 的具体类型与配置未能核实**：盘点基于代码路径推演（analysis 无 L1、无 L2）。若 PMO-12 那单实际是 trigger 巡检单（无频道 + 无 TASK），则连人工 L3 都被豁免（`analysis-handoff.ts:99-110`）——需查该 WU 的实际 metadata 确认走了哪条分支。
2. **`POST /:id/status` 端点的实际调用方未盘**：它无 human-only 限制（`workunit.routes.ts:540-567`），可在状态机允许范围内直推 in_review→done 且不落 l2/l3 台账。是否存在 agent/自动化调用它绕过 review 的实际流量，需查调用日志或全仓调用方。
3. **轻量路径 `outputText` 为空的边界**：`parseAgentOutput` 无 ACTION 行默认按 progress（`agent-loop-parsers.ts:80`），但 exit 0 + `is_error=false` 且 stdout 完全为空时 `extractResult` 的行为（空串 vs 异常）未逐行确认，可能影响「空输出被判 progress 后无限循环」的边界。
4. **多 session 路径（executeSessionLoop）是否仍是活的代码**：`apps/` 下无生产调用方，但包内完整保留且测试覆盖。是否属于待清理的 legacy 或预留能力，需 #73 裁决口径外的确认。
5. **L2 reviewer 自身的完成质量**：review WU 豁免提交守卫（`completion-gates.ts:425`）且不跑 L1（`wu-verification.ts:17`），REVIEW_RESULT 解析失败只转人工——reviewer 干错活时同样无自动拦截，其「review 的 review」完全依赖人工，本次未单独评估该层风险敞口。
