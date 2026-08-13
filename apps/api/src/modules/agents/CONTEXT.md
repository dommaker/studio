# agents

> 此文件描述 apps/api/src/modules/agents 目录的职责和上下文

## 职责

负责管理 Agent 的配置（profile）、运行实例（instance）、决策循环（loop）以及内部审计 Agent（Auditor）等核心编排逻辑。提供 REST API 进行 CRUD 操作，并通过事件驱动机制实现 Agent 的自动挂载、运行和终止。

## 目录结构（工单 31，2026-08 按子域重组）

- `loop/` — 决策循环与 WU 执行链（agent-loop 及拆出文件、executor/remote-executor、completion-gates、wu-verification、execution-step-events、review-contract/review-dispatcher、daily-token-budget）
- `auditor/` — Auditor 内部 Agent（service/rules/execution/reports）
- `monitor/` — Monitor 内部 Agent（service/probes/system-probes/alerts/reports/lifecycle）
- `ops/` — 进程级守护（ops.service/ops-rules/system-health）
- `knowledge/` — 知识维护 Agent（curator/cold-start/extraction/maintenance）
- `triage/` — Triage 内部 Agent（triage.service）
- 根目录 — 共享与 legacy CRUD：routes、types、agent-profile/*、agent-instance/*、token-usage/*、default-provider、default-triggers、system-executor、session-summary.service、requirement-gate

## 核心导出

- `monitor/monitor.service.ts` — MonitorAgent 门面（健康监控 + 渐进告警，每 5min 轮询），T3 拆分后仅保留聚合/调度逻辑与实例状态；对外导出 `MonitorAgent` / `monitorAgent` 不变。
  - `monitor/monitor-probes.ts` — 任务/WorkUnit 级探测（失败趋势/停滞/超时/工具模式）
  - `monitor/monitor-system-probes.ts` — 系统/知识级探测与自修复（systemHealthCheck/worktree GC/知识健康循环/KnowledgeSync）
  - `monitor/monitor-alerts.ts` — 告警分发/Triage 升级（FL-037）/studio.jsonl 事件写入
  - `monitor/monitor-reports.ts` — 轨迹评估（G4）/每日洞察（DailyReflection）/交互模式观察（B9-025）
  - `monitor/monitor-lifecycle.ts` — G31 知识沉淀闸门 + 每日 23:55 数据 TTL 清理
- `auditor/auditor.service.ts` — AuditorAgent 门面（跨任务审计 + 周期洞察，每 24h 日审），T3 拆分后仅保留聚合/委托逻辑；对外导出 `AuditorAgent` / `auditorAgent` 不变。
  - `auditor/auditor-rules.ts` — 审计规则（错误归类/技能与 agent-type 建议 B3-005/用户模型质量/知识电路健康 I2）
  - `auditor/auditor-execution.ts` — 建议执行（低风险自动应用/确认卡片+铃铛通知/RKB Resolution 创建/Triage 升级/eval case 生成）
  - `auditor/auditor-reports.ts` — 洞察与报告输出（会话行为趋势/B13-011 七日趋势/tier 成功率反馈/#系统 推送）
- `knowledge/knowledge-curator.service.ts` — KnowledgeAgent 门面（知识库冷启动 + F1 每日维护），T3 拆分后保留公共 API（coldStartAll / runDailyMaintenance 聚合）；对外导出 `KnowledgeAgent` / `knowledgeAgent` / `EXTRACT_FROM_TEXT_SYSTEM_PROMPT` / `getExtractFromTextSystemPrompt` 不变。
  - `knowledge/knowledge-extraction.ts` — 提取 prompt 单一来源（EXTRACT_FROM_TEXT_SYSTEM_PROMPT + E1 文件覆盖 getter）
  - `knowledge/knowledge-cold-start.ts` — 冷启动四源导入（P1b: docs/code/git/manual）+ Discord 通知
  - `knowledge/knowledge-maintenance.ts` — 语料分析（F1：语义去重/质量评估/过期验证/矛盾审查）
- `default-triggers.ts` — 10 个系统默认 trigger 注册（含 `doc-semantic-review` 周级文档语义审查，2026-07 文档治理闭环 P1）
- `agent-loop.ts` — AgentLoop 门面（observe→resolveTarget→agentStep→recordResult 决策循环，AS-025），T3 拆分后仅保留循环主流程（start/runLoop/observe/agentStep 编排 + 薄壳委托）与 re-export；对外导出 `AgentLoop` / `parseAgentOutput` / `parseReviewReport` / `parseTaskBreakdown` / `dynamicInterval` / `analyzeKnowledgeSearch` / `extractKnowledgeEntryIds` / `extractInputTokens` / `resolveRealUsage` / `writeWorkunitTokenEvent` / `resolveToolTraceFile` / `writeToolCallEvents` / `isProcessAlive` / `isGitRepoRoot` / `resolveWorktreesDir` / `findAnchorMessage` / `resolveTarget` / `testWuGuardEnabled` / `isTestLikeWorkUnit` 及类型 `StepResult` / `KnowledgeSearchAnalysis` / `RealUsage` / `WorkunitTokenEventArgs` / `Observations` / `Target` 不变。
  - `agent-output-parser.ts` — ACTION 协议解析（parseAgentOutput）/ REVIEW_RESULT 审查结论解析 / TASK: 分析拆分行 / 动态轮询间隔（dynamicInterval）
  - `agent-knowledge-analysis.ts` — 知识检索行为分析（stream-json 日志 → searchCalls / 知识条目 id 提取）
  - `workunit-token-events.ts` — workunit:tokens / tool:call 事件写入（M2 成本红线 + B6 真实账单口径）+ STUDIO_EVENTS_JSONL 路径解析
  - `agent-loop-utils.ts` — 进程存活 / git 仓库根 / worktrees 目录小工具
  - `agent-targeting.ts` — Observations → Target 解析（认领优先级）+ 频道锚点消息
  - `wu-test-guards.ts` — B2 测试特征 WU 判定（STUDIO_TEST_WU_GUARD 开关 + scope 模式）
  - `prompt-composer.ts` — prompt 组装（base prompt 选择 + guard hint 注入 + map/skills/persona/roster/memory/knowledge/handoff 注入段，#91 分段软定额 + 池内余量共享 + section_trimmed 埋点；#111 T5 探路地图完整段：destination + 近 N 条 decisions + 开放 fog 清单，纳入分段预算首段，non-blocking；#95 handoff 前序进展段：续用不命中（含执行期降级换新号——check 判命中但执行报「会话不存在」时重算 prompt）+ stepCount>0 时注入，挂 base 后/hint 前，waitingQuestion 仅新会话回放截 300 字符）
  - `agent-loop-workspace.ts` — 执行根目录/worktree 解析（B3a 归属链 / B3b-i 专属 worktree / 提交守卫 git 探针；#113 T7 多腿：PMO 分支解析经 requirements `pmo-branch-resolver` 按 WU→腿归属出腿分支——metadata.workspaceRoot/worktreeBaseRepo 命中腿 gitRepo 或 pmoBranch 命中腿 branch，未命中回落项目级分支，单腿行为不变）
  - `session-resume.ts` — #94 会话续用判定纯函数（只信档案 metadata.sessionId；claude 按 cwd 校验 `~/.claude/projects/<cwd-slug>/<id>.jsonl` 存在性，slug = cwd 的 `/`、`.` → `-`；kimi/codex/opencode 档案有号即续用；RESUME_FAILURE_RE 识别「会话不存在」错误供降级重试）。B5 会话数上限（MAX_SESSIONS_PER_WU=5，#95 2→5，失败/超时的会话建立尝试计入预算）与降级重试编排在 agent-loop.ts agentStep
  - `agent-loop-instance-state.ts` — 运行时实例状态写入（启动失败记录 / idle 心跳 / 忙闲 SSE）
  - `agent-loop-record-result.ts` — recordResult（提交/子任务/验证守卫 + DELEGATE + 新鲜度检查 + 状态迁移 + 里程碑回帖）
  - `agent-loop-step-guards.ts` — agentStep 前置守卫（B2 测试特征 WU 关闭 / C3 每日 token 预算熔断）
- `default-provider.ts` — F1 provider 默认选取工具（2026-07-28 分析文档）：`resolveDefaultProvider()` 取 `scanAllProviders()` 第一个（扫不到 → null + warn，不再隐式兜底 claude）；`backfillProfileProviders()` 启动时回填存量空 provider 的 active 角色（不含 studio，幂等）。`agent-profile.service.create` 缺省 provider 经此打戳
- `loop/executor.ts` — §9.6 Executor 接口（AgentLoop 执行面抽象）：P0 `LocalExecutor` 原样委托 `agentRunner.executeLightweight`；P1 远程节点执行经同一接口接入
- `loop/execution-step-events.ts` — WU 过程可视化（2026-07-30）：Layer A 步级——每个 agent step 结束把 stream-json rawOutput 提炼成 `workunit:execution_step` 事件（thinking ≤3×500 字符 / toolCalls ≤30×160 字符摘要 / skills 注入名单 / usage），落盘 studio-events.jsonl（REST 回放）+ `workunit.execution.step` SSE 信封（自动落 workunits topic）；Layer B 步内流式——execSh `onLine` 把 CLI stdout 按行透传（runner-lightweight 接线 `AgentTask.onStreamLine`），每行提炼成轻量 chunk（thinking/text/tool/result，≤500 字符、单行 ≤10 条）经 `workunit.execution.stream` SSE 直发，**只发 SSE 不落盘**（行级体量防膨胀），agent-loop 在 spawn 前合成 step-start 信号。不进频道、不写 metadata 防膨胀；fire-and-forget 绝不影响任务流程。完整 transcript 不回放这里——查 agent HOME 的 `.claude/projects/<cwd-slug>/<sessionId>.jsonl`
- `loop/wu-verification.ts` — B3b-i WU 自动验证的可复用实现（2026-07-30 F6-c 从 agent-loop 原样抽出，行为不变）：`CODE_WORKTREE_TYPES` / `resolveVerifyCommands`（覆盖 > 约定）/ `runWuVerification` / `extractExecOutputTail`；消费方 = completion-gates 的 COMPLETE 验证守卫 + agent-loop 步骤超限强制收口路径 + workunit 模块 `POST /workunits/:id/verify`
- `loop/completion-gates.ts` — 收口守卫链（2026-08 从 agent-loop.recordResult 抽出，行为不变）：`runCompletionGuards(ctx, deps)` 依次跑 §10.5 提交守卫（含 PROGRESS 无提交监视）→ §6-2 子任务守卫 → B3b-i 自动验证守卫（消费 wu-verification），守卫顺序即优先级（前者降级后后者不触发）；hint 写入（commitGuardHint/childGuardHint/verifyFailHint）与 l1 台账（approved/rejected）在本模块，git 探针 `hasUncommittedChanges`/`readHeadHash` 与验证实现经 deps 注入（单测纯 ctx 对象驱动，无需模块工厂 mock）；recordResult 只保留编排（构建合并视图 → 守卫 → delegate/新鲜度/强制收口补验 → 单次原子写 → 状态迁移/频道通知）；hint 的消费与清除仍在 agentStep（属 prompt 组装，非守卫政策）
- `loop/review-contract.ts` — 审查结论（verdict）语义单一来源（2026-08 收编）：`ReviewVerdict`（pass/reject/needs-info）与 issue 词表 + `ParsedReviewReport` 落档形状。消费方：agent-loop parseReviewReport（返回类型）、review-dispatcher.ts（路径 B 消费同型）。**2026-08-06 旧管理端点链路整体删除**：review.service.ts / review-report.ts / `POST /review/diff` 端点零真实调用方（web/CLI/scripts 均无），legacy 映射函数（deriveVerdictFromLegacyReport 等）随之移除；verdict 语义仅剩新管线一处解释
- `loop/agent-loop.ts` — AgentLoop 决策循环编排（observe→resolveTarget→agentStep→recordResult）。工单 28（2026-08）拆分后本文件只保留类编排逻辑与 re-export（对外导出语义不变），纯函数/辅助各归其位：
  - `loop/agent-loop.types.ts` — 类型契约（`StepResult`/`Observations`/`Target`/`RuntimeInstanceRow`/`KnowledgeSearchAnalysis`，纯类型零运行时依赖）
  - `loop/agent-loop-parsers.ts` — 输出解析与 prompt 模板纯函数（ACTION 协议 `parseAgentOutput`/`parseReviewReport`/`parseTaskBreakdown`/`extractInputTokens`、目标选择 `resolveTarget`/`dynamicInterval`、进程/git 探针、continue/reply prompt 模板）
  - `loop/agent-loop-events.ts` — `workunit:tokens` 与 `tool:call` 事件落盘（`writeWorkunitTokenEvent`/`resolveRealUsage`/`writeToolCallEvents`，含共享 `metricsFileStore`）
  - `loop/agent-loop-guards.ts` — B2 测试特征 WU 守卫（`testWuGuardEnabled`/`isTestLikeWorkUnit`）+ F4 `parseExcludeAssignee`
  - `loop/context-overflow.ts` — #96 CLI 上下文溢出纯反应式策略（纯函数零服务依赖）：`OVERFLOW_ERROR_RE`/`isContextOverflowError` 溢出识别（与 `RESUME_FAILURE_RE`「会话不存在」是不同失败类型；匹配 "Prompt is too long"/context length/token limit 等）+ `buildRollingSummary` 会话滚动摘要构建（来源 = wu.scope + progressLog，不递归摘要、不建语义搜索）。编排（溢出重试/配额检查/摘要落盘）在 agent-loop.ts agentStep

## 依赖关系

- 上游
  - `@dommaker/studio-shared`（eventBus、FileStore、logger、parseStreamEvents 等）
  - `@dommaker/studio-shared/node`（resolveProviderDefinition、buildHealthProbeCommand）
  - `@dommaker/studio-agent`（agentRunner、AgentTask、ExecutionResult）
  - `../../utils/errors.js`、`../../utils/pagination.js`
  - `../workunit/workunit.service.js`（WorkUnitService）
  - `../knowledge/knowledge-service.js`、`../knowledge/knowledge-bus.service.js`
  - `../triggers/trigger-registry.js`、`../workspaces/workspace-store.js`
  - `../../core/event-store.js`
  - 子模块：`auditor/auditor-rules.js`、`auditor/auditor-execution.js`、`auditor/auditor-reports.js`
- 下游
  - **apps/api/src**（cli/server.ts、index.ts、route-registry.ts）—— API 入口挂载 agents 路由及启动时初始化
  - **apps/api/src/modules/knowledge**（internal.routes.ts、knowledge-service.ts）—— 知识模块依赖本目录的 knowledge-agent.service 等
  - **apps/api/src/modules/workunit**（waiting-input.ts）—— 等待输入流程引用 agent 实例

## 注意事项

- **#96 CLI 上下文溢出纯反应式策略（2026-08-13）**：`SESSION_TOKEN_LIMIT`/`checkSessionTruncation` 观测防线整体删除（生产从未生效，读 outputText 纯文本从未命中过）。溢出改为纯反应式：CLI 回报溢出错误（`loop/context-overflow.ts` `OVERFLOW_ERROR_RE`）→ 会话滚动摘要落盘（`metadata.sessionSummary`，来源 = wu.scope + progressLog，不递归摘要）→ 新会话带摘要注入重试一次 → 再败 NEED_INPUT。溢出重试占会话配额（超限走 need_input），#95 续用降级路径也收口遵守 `MAX_SESSIONS_PER_WU`（删除 #94「绕过 MAX 一次」先例）；预防层（token 记账 + 阈值预警）不建
- **AgentProfile 持久化布局**：`~/.studio/data/agents/{id}/profile.json`（身份：name/description/provider/status/nodeId，模型见 `packages/studio-shared/src/file-store.ts`，无 systemPrompt 字段）+ 同目录 `state.json`（运行时实例）；原子写 + mkdir 锁，永久存在仅可显式 DELETE；保留名 `studio`（系统执行角色，provider 由 StudioRoleSetupModal 补配）
- **prompt 注入架构 = index-on-demand（严禁全量注入）**：skills 走索引+按需（step 时匹配：#92 硬预裁剪——只注入 +skill 点名 + 域匹配两类（scope 文本匹配与 rest 热度不进段，段尾 `~/.studio/skills/MANIFEST.md` 指针按需兜底），预裁剪后仍按段有效预算块级截断取代封顶 3；prompt 只放 name+description+triggers 摘要+`~/.studio/skills/<name>/SKILL.md` 绝对路径指针，正文不注入，agent 按需阅读，见 `loop/prompt-composer.ts` buildSkillSection）；知识分层（rule/context 约束层按设计全量、signal 层 `[id] summary` 索引、reference 层只报条数，见 knowledge-service.injectContext）；roster 只放 `name（provider）：description` 索引行且不含自身；#91 起注入段按分段软定额 + 池内余量共享截断（map 800（#111）/ skills 600 / persona 300 / roster 400 / memory 300 / knowledge 1000 / handoff 800，前段余量流入后段，总量 ~4.3K；任一段截断落 `prompt:section_trimmed` 事件；handoff 段内容源 = #95 前序进展段（2026-08-13 落地：续用不命中 + stepCount>0 注入，挂 base 后/hint 前，waitingQuestion 仅新会话回放截 300 字符；段序整体稳定性重排归 #119）；memory 段内容源归 #100，落地前恒空）；persona 段消费 role preset 的 persona + skills/tools/constraints（#91 修复 preset 三字段不落盘不消费的断链）。不注入：agent 完整记录、频道列表、成员 ID、记忆
- **#111 T5 探路地图完整段（2026-08-11，接替 #107 T1 一行 tracer bullet）**：WU `metadata.pmoId` 反查 PMO 有 `map` 时渲染 `## PMO 地图` 段（无 pmoId / 无 map / 读取失败 → 不渲染，non-blocking）——destination 一行 + 近 N 条 decisions（新→旧，decisions[] 尾 = 最新；summary 超 160 字符截断加省略号）+ 开放 fog（open/in-discussion，resolved 不列）清单；段文本拼进 base prompt（开场白落点，不进 knowledgeContext）。**N=10、定额 800 token 实测校准**（口径 `estimateTokens` = chars/4）：典型场景（10 决策 × 30 字 summary + 5 雾 × 20 字）≈160 tok；顶格偏重（10 决策 × 160 字 + 15 雾 × 60 字）≈720 tok 仍在定额内；N=12 顶格偏重 ≈806 tok 破定额故取 10；30 条雾不可裁底 ≈570 tok，「fog 全保留」与 800 定额兼容。超预算截断策略：**fog 全保留，decisions 从旧到新逐条裁**（保最新）；决策裁光仍超（fog+destination 病态规模）按 chars/4 兜底截。N 封顶不算截断；预算裁条落 `prompt:section_trimmed` 事件（payload：section=map / originalTokens / trimmedTokens / quota=800，同 #91 管道经 metricsFileStore 写 studio-events.jsonl）
- A2A 协作 P1（2026-07-agent-to-agent-collab-design）：`ACTION: DELEGATE:@<profileName>:<scope>` 协议由 recordResult 拦截，经 workunit/delegation-gate 校验后建子单（`metadata.collab`）+ 发 delegate 卡片，拒绝则降级 NEED_INPUT；父 complete 守卫（未完结子 WU → 降级 progress）；发言层新鲜度检查（step 期间房间有外部新消息 → 结果帖拦截注入 pendingReplies，连续 2 次后照发）；花名册段（## 频道成员与委派）纳入 #91 分段定额（roster 400 + 池余量）
- Idle 心跳间隔固定 45 秒（`IDLE_HEARTBEAT_INTERVAL_MS`），配合超时扫描 5 分钟阈值
- `AgentLoopRegistry.mount()` 幂等且不抛错，失败仅标记为 failed 状态
- 路由层统一使用 `getErrorMessage` 捕获异常，并返回标准错误码（如 `INTERNAL_ERROR`、`NOT_FOUND`）
- 所有 Agent 数据均通过 `FileStore` 存储（已从 Prisma 迁移）
- 审计日志写入 `~/.studio/logs/studio-events.jsonl` 文件
- `agent-profile.service.ts` 在创建 profile 时会发布 `agent-profile.created` 事件，由 `AgentLoopRegistry` 监听并自动挂载 loop
- **mention 派单调度链**：`WorkUnitService.create` 发 `workunit.created` 事件 → TriggerScheduler 唤醒对应 AgentLoop.observe（另有 15s 轮询兜底）→ 过滤（assigneeId 精确匹配 / 频道成员 / F4 `metadata.excludeAssignee` 排除实现者 / #109 `metadata.blockedBy` 有未 done 依赖则不可见）→ claim（assigneeId 改写为 instance.id）→ agentStep → LocalExecutor → runner-lightweight spawn CLI → recordResult 解析 ACTION → postToDiscussionSpace 经 workunit `wu-messenger.postWuSystemMessage`（agentName=本 loop role.name，绑定 loop 自身 fileStore，测试可注入临时 store；内部走 `ChannelMessageService.createAgentMessage`）回帖（**2026-07-29 起走 EventBus/SSE**，此前直写 fileStore 不发事件，频道页只能轮询/刷新才能看到 agent 回复）
- **F4 review 派发（2026-07-28 分析文档决策 5）**：ReviewDispatcher 不再按 description 含 'reviewer' 找具名角色（字符串锚点已废除，`builtin-roles.ts` 已删除）——父 WU 进 in_review → 建 `assigneeId=null` 的未指派 review 子 WU 走 claim 涌现；实现者（assigneeId 两种形态：profile id / instance id→state.roleId）写入 `metadata.excludeAssignee` 禁止自领；频道内除实现者外无 active 成员（或 members 未回填）→ 自评兜底：不排除 + `metadata.selfReview=true` + 频道系统消息提醒人工复核
- **R3 评审输入契约（2026-07-28 分析文档 §4-R3）**：评审子 WU scope = diff-only + `+code-review` 点名——只审 `git diff <baseBranch>...HEAD`（实现叙述仅作背景定位）；上下文失效 `verdict=needs-info` → parseReviewReport 返回 null → 转人工（不猜不硬判）；`metadata.reviewInput` 落档审计。评审回传经 reviewPassed/reviewRejected 的 attestation 入参落父 WU 台账 l2（selfReview/ref 透传，F6 决策 1）
- **PMO 分析接力（2026-07-29）**：ReviewDispatcher 路径 A 跳过 `type='analysis'`（分析结论的评审 = 人工确认 F6 l3，diff-only 契约对非代码产物恒 needs-info 纯噪声；接力提示与派工见 pmo/analysis-handoff.ts）。analysis WU COMPLETE 时 agent-loop 用 `parseTaskBreakdown` 解析输出中的 `TASK: <任务描述>` 行（去重/封顶 ANALYSIS_TASKS_MAX=8/条 ≤300 字符）落 `metadata.analysisTasks`；契约写在 pmo/project.service.publish 的 analysis scope 里，人工「通过」后由 analysis-handoff 建未指派 task 子 WU 派工。**#106 M7 对齐（2026-08-12）**：同一 COMPLETE 还用 pmo/map-opening 的 `parseMapOpening`（契约单一来源）解析 `FOG:`/`DESTINATION:` 行落 `metadata.analysisFog`/`analysisDestination`——web 确认弹窗据此预填待决问题清单，人审改后随 l3.summary 回传开图；无 FOG 行 = 非探路型不落档
- **#108（2026-08-11）decision/spec 不派评审**：ReviewDispatcher 跳过集扩 `DECISION_SPEC_TYPES`（路径 A 与 `dispatchReviewNow` 人工补派同拒）——决策单/成文单验收走人工 in_review（同 analysis 先例），review 子 WU 不从 decision/spec 派生；配套裁剪状态机与超时豁免见 workunit/CONTEXT.md
- **F6 台账 l1（决策 1）**：COMPLETE 前自动验证守卫同时写 `metadata.attestations.l1`（approved/rejected 都落，by=profile id；守卫实现见 `loop/completion-gates.ts`）
- **F6-c 证据断链修复（2026-07-30）**：①验证逻辑抽出 `loop/wu-verification.ts`（见核心导出）；②**步骤超限强制收口补跑 L1**——COMPLETE 守卫只在 action=complete 时跑，超限路径（任意 action）此前完全跳过验证，强制 in_review 的代码类 WU 永远缺 l1；现在收口前对代码类 + 有 worktree 的 WU 补跑一次（本 step 守卫已跑则不重复），台账写法同守卫但不计 verifyFailCount、不改 blocked 语义；③`POST /workunits/:id/verify` 人工重跑 L1（human-only，只动台账不动状态，见 workunit/CONTEXT.md）；④`POST /workunits/:id/dispatch-review` 人工补派评审（`ReviewDispatcher.dispatchReviewNow`，复用路径 A 建单逻辑；守卫：type≠review/analysis、status∈in_review/done、deriveDisplayState 判定 l2 未达成、有频道、无在途评审子 WU）+ handleReviewChildDone 放宽——父已被人工直推 done 且 l2 缺失时，迟到 approved 经 reviewPassed F6-c 幂等口补写 l2（不动状态；迟到 rejected 不打回人工收口的 WU，频道转人工复核）。幂等补写证据后发 status_changed（状态值不变也发）让 pmo rollup 重估。**纪律：验证失败只落 l1 rejected，绝不写 verifyReport**（metrics 按 verifyReport 存在计通过，失败写入会虚增通过率）
- **isOnline 语义（2026-07-27 起）** = loop 存活：state status 为 idle/active 且心跳新鲜（≤5min，与 agent-timeout-scan 同阈值；null 心跳按 startedAt 宽限）。另知一坑（未修）：手动 `POST /agent-instances` 只建 idle 记录、并不起 loop，null 心跳约 2 分钟内被 timeout-scan 终止（假在线）
- **多实例单活（2026-07-30 走查修复）**：同一 `~/.studio` 被多 api 实例共享时（本机 dev:13001 / prod:13101 并存），`STUDIO_AGENT_LOOP_ENABLED=false` 的实例 standby——index.ts 不注册系统触发器（含定时 WU 创建）不挂载 loop，但保留 ReviewDispatcher/AnalysisHandoff/事件桥订阅（状态变更由谁发起就在谁进程内触发，两侧都有幂等哨兵）。此外 `AgentLoop.start()` 内置同角色单活守卫：另一进程持有的活实例（异 pid 存活 + 心跳/启动时间 <120s 新鲜）存在时 standby 返回 false 并记 error 状态（message 含「活实例」），持有者退出后重启即接管；AC-4.6 stale 清理只管死 pid，管不了双活进程
- **instance 忙闲 SSE（2026-07-31 PMO-flow UX §6-2）**：agent-loop 在 claim 后置 active 与 `updateIdleState` 两处经 eventStore 发 `agent.instance.status_changed`（信封同 agent.health.failed；data = `{profileId,instanceId,name,status,currentWorkUnitId}`）。sse.routes 无 `agent.*` 显式映射 → 落 `all` topic，前端订阅 all 即收（无需改路由）。`lastPublishedStatus` 内存去重：仅状态实际变化时发一次——updateIdleState 的 45s 节流心跳重入 idle 不刷屏
- **里程碑消息 meta（2026-07-31 PMO-flow UX §6-3）**：recordResult 四类里程碑（COMPLETE 汇报/NEED_INPUT/验证失败 ≥3 次打回 blocked/连续 3 步无进展 blocked 转人工）经 `postToDiscussionSpace` 第三参传持久化 wu 本体（2026-08 归因统一后解析链只读创建期落档数据（metadata.pmoId/reqId），原「持久化 + 本 step metadataUpdates」合并视图已随 pmoProjectId 缓存一并移除），由 wu-messenger 按 `milestone: true` 附带 meta `{pmoId?, atHuman:true}`（pmoId 由 requirements 模块 `resolvePmoProjectIdForWU` 解析，解析不到不携带）；普通 progress 不带。ReviewDispatcher.postSystemMessage（评审结果转人工）同样委托 wu-messenger 里程碑通道；`MessageMeta` 增 `pmoId` 字段（channel-message.service）
- **ReviewDispatcher 子 WU 不继承会话簿记（2026-07-30 走查修复）**：review 子 WU metadata 原样 spread 父 WU 会带上 `sessionId` 等字段 → 子 WU 误续用父 WU 的 CLI 会话（违反「同一 WU 内才续用」，异 cwd 必失败；root 下 `--resume` 还会触发 CLI 自注入 `--dangerously-skip-permissions` 被 root guard 秒拒 exit 1）。createReviewWorkUnit 经 workunit/wu-metadata 的 `clearSessionBookkeeping` 清除（**15 字段权威清单 2026-08-13 起**（#94 增 lastSessionResumed、#95 增 progressLog、#96 增 sessionSummary）：sessionId/startedAt/sessionResumes/sessionCount/lastSessionResumed/blockReason/stepCount/consecutiveStuck/errorType/errorDetail/errorAt/_cumulativeTokens/lastInputTokens/progressLog/sessionSummary；agent-loop 新增簿记字段必须同步该清单）；pmoId/pmoNumber 等域血缘保留
- **鉴权（2026-07-24 收紧）**：legacy agents POST `/`、PUT `/:agentId` 与 agent-profiles/agent-instances 写 = `requireAuth()+requireNotGuest()`；instances `POST /:id/terminate` = `requireAuth()+requireAdmin()`；legacy DELETE 原有 requireRole('Admin') 不变。agent-configs 模块已随工单 20 整体删除（前端零调用，其 `:id` 路径拼接穿越面连带消亡）。`POST /review/diff` 端点已随旧 review 栈删除（2026-08-06）——其 shell 拼接面、.claude/settings.json 写任意仓库、.review-prompt.md 残留三个隐患连带消亡
- **频道发声策略（2026-08-09，#55 决议，待实现）**：频道发声集 = 里程碑 + 异常 + 每步简报（现状）；补两个缺口——①每次认领发一条 WU 线程普通消息（「『角色名』已认领任务，开始执行」，含超时释放后的重新认领，与 timeout-release 释放消息配对）；②每次步失败发一条普通消息（「执行失败（第 N 次）：原因截断」，不带 atHuman；重试不单独发声；连续第 3 次走现有 blocked 里程碑收尾，不变）。认领/失败消息按**系统通知**对待，不过 §4.2 发言层新鲜度检查（闸只拦 agent 结果回帖）；届时更新 agent-loop.ts:746「失败不是发言」的过时注释
- **认领门槛定型（2026-08-09，#56 决议）**：认领层维持纯显式，永不引入类型/角色匹配机制——acceptedTypes 的语义定位就此锁定为 **skill 排序的可选提示**（决策 9 出生定位），不得作为路由/认领的输入（决策 10 原则被 PMO-12 事件检验后保留：推断只配出现在低代价处）。认领仅有的三个门槛：`assigneeId` 排他指派（人工 @mention）+ review 的 `metadata.excludeAssignee` + #109 的 `metadata.blockedBy` 未了结依赖门禁（了结口径 = done/closed，判定收敛在 workunit/wu-dependencies.ts，全局 index 跨 PMO 生效）。「WU 无人认领滞留池中」的探测归 #62（monitor-probes 的停滞探测只扫 active，unassigned 无覆盖）。创建侧人工可选显式指派（publish/分析确认节点）留作后续可选增强 #69
- **#90 失败步 outcome 埋点（2026-08-13）**：失败步最终收敛处——action=failed（`failResult`）/ 溢出·续用降级重试再败转 need_input / spawn 异常 catch——经 `agent-loop.ts` `recordOutcomeEvent`（单一正本）落 `knowledge:outcome:failure` 事件（success=false + `errorType='execution_failed'` + details=错误原文）；成功步经同一正本落 `knowledge:outcome:success`（errorType 缺省，JSON 丢弃）。`ExecutionOutcome` 增 `errorType?`（knowledge-service.ts 与 knowledge-types.ts 两处同构）。`extractFromExecution` 仅成功步触发（失败无 diff）。会话预算耗尽的前置 need_input（未执行即返回）不算失败步不埋点。AC2（提取跳过原因四重门）已划掉归 #99
- **#90 Auditor 零执行噪声抑制（2026-08-13）**：`dailyAudit()` 过去 24h `total===0`（零执行）早退——不 push #系统摘要、不 `recordPattern`（trend）、不 `escalateToTriage`、不生成 eval case/resolution（`generateEvalCases`/`autoCreateResolutions`）；有执行时行为不变。早退点 = `recentExecs.length===0` 判定后、任何分析/建议执行前
- **#99 WU 收尾批量提取钩子（2026-08-14）**：role-memory/completion-extraction.ts 订阅 `workunit.status_changed` → done，读归档 transcript（#97 readTranscript）→ 一次 LLM（`getSystemExecutor` + `MEMORY_EXTRACTION_SYSTEM_PROMPT`）→ `roleMemoryStore.appendDraft`（角色记忆草稿区）。与旧 R3 会话提取（COMPLETE 步 → `extractFromConversation`，proposal 入库 KnowledgeStore）并行独立，去重哨兵各用各的：R3=`knowledgeExtractedAt`、#99=`memoryExtractedAt`（WorkUnitMetadata 两字段并存）。跳过原因四重门（去重哨兵/no-role-id/预算熔断/空 transcript）与成功/失败均落 `knowledge:extraction` 事件（`trigger:'wu-completion'`），fire-and-forget 不阻塞收尾；旧 R3 路径及其触发器删除归 #102
