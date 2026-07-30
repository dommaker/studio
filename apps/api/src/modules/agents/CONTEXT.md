# agents

> 此文件描述 apps/api/src/modules/agents 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-30 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/CONTEXT.md, apps/api/src/modules/agents/agent-loop.ts, apps/api/src/modules/agents/review-dispatcher.ts

## 职责

负责管理 Agent 的配置（profile）、运行实例（instance）、决策循环（loop）以及内部审计 Agent（Auditor）等核心编排逻辑。提供 REST API 进行 CRUD 操作，并通过事件驱动机制实现 Agent 的自动挂载、运行和终止。

## 核心导出

- `monitor-agent.service.ts` — MonitorAgent 门面（健康监控 + 渐进告警，每 5min 轮询），T3 拆分后仅保留聚合/调度逻辑与实例状态；对外导出 `MonitorAgent` / `monitorAgent` 不变。
  - `monitor-probes.ts` — 任务/WorkUnit 级探测（失败趋势/停滞/超时/工具模式）
  - `monitor-system-probes.ts` — 系统/知识级探测与自修复（systemHealthCheck/worktree GC/知识健康循环/KnowledgeSync）
  - `monitor-alerts.ts` — 告警分发/Triage 升级（FL-037）/studio.jsonl 事件写入
  - `monitor-reports.ts` — 轨迹评估（G4）/每日洞察（DailyReflection）/交互模式观察（B9-025）
  - `monitor-lifecycle.ts` — G31 知识沉淀闸门 + 每日 23:55 数据 TTL 清理
- `auditor-agent.service.ts` — AuditorAgent 门面（跨任务审计 + 周期洞察，每 24h 日审），T3 拆分后仅保留聚合/委托逻辑；对外导出 `AuditorAgent` / `auditorAgent` 不变。
  - `auditor-rules.ts` — 审计规则（错误归类/技能与 agent-type 建议 B3-005/用户模型质量/知识电路健康 I2）
  - `auditor-execution.ts` — 建议执行（低风险自动应用/确认卡片+铃铛通知/RKB Resolution 创建/Triage 升级/eval case 生成）
  - `auditor-reports.ts` — 洞察与报告输出（会话行为趋势/B13-011 七日趋势/tier 成功率反馈/#系统 推送）
- `knowledge-agent.service.ts` — KnowledgeAgent 门面（知识库冷启动 + F1 每日维护），T3 拆分后保留公共 API（coldStartAll / runDailyMaintenance 聚合）；对外导出 `KnowledgeAgent` / `knowledgeAgent` / `EXTRACT_FROM_TEXT_SYSTEM_PROMPT` / `getExtractFromTextSystemPrompt` 不变。
  - `knowledge-extraction.ts` — 提取 prompt 单一来源（EXTRACT_FROM_TEXT_SYSTEM_PROMPT + E1 文件覆盖 getter）
  - `knowledge-cold-start.ts` — 冷启动四源导入（P1b: docs/code/git/manual）+ Discord 通知
  - `knowledge-maintenance.ts` — 语料分析（F1：语义去重/质量评估/过期验证/矛盾审查）
- `default-triggers.ts` — 10 个系统默认 trigger 注册（含 `doc-semantic-review` 周级文档语义审查，2026-07 文档治理闭环 P1）
- `default-provider.ts` — F1 provider 默认选取工具（2026-07-28 分析文档）：`resolveDefaultProvider()` 取 `scanAllProviders()` 第一个（扫不到 → null + warn，不再隐式兜底 claude）；`backfillProfileProviders()` 启动时回填存量空 provider 的 active 角色（不含 studio，幂等）。`agent-profile.service.create` 缺省 provider 经此打戳
- `executor.ts` — §9.6 Executor 接口（AgentLoop 执行面抽象）：P0 `LocalExecutor` 原样委托 `agentRunner.executeLightweight`；P1 远程节点执行经同一接口接入
- `execution-step-events.ts` — WU 过程可视化（2026-07-30）：Layer A 步级——每个 agent step 结束把 stream-json rawOutput 提炼成 `workunit:execution_step` 事件（thinking ≤3×500 字符 / toolCalls ≤30×160 字符摘要 / skills 注入名单 / usage），落盘 studio-events.jsonl（REST 回放）+ `workunit.execution.step` SSE 信封（自动落 workunits topic）；Layer B 步内流式——execSh `onLine` 把 CLI stdout 按行透传（runner-lightweight 接线 `AgentTask.onStreamLine`），每行提炼成轻量 chunk（thinking/text/tool/result，≤500 字符、单行 ≤10 条）经 `workunit.execution.stream` SSE 直发，**只发 SSE 不落盘**（行级体量防膨胀），agent-loop 在 spawn 前合成 step-start 信号。不进频道、不写 metadata 防膨胀；fire-and-forget 绝不影响任务流程。完整 transcript 不回放这里——查 agent HOME 的 `.claude/projects/<cwd-slug>/<sessionId>.jsonl`
- `wu-verification.ts` — B3b-i WU 自动验证的可复用实现（2026-07-30 F6-c 从 agent-loop 原样抽出，行为不变）：`CODE_WORKTREE_TYPES` / `resolveVerifyCommands`（覆盖 > 约定）/ `runWuVerification` / `extractExecOutputTail`；消费方 = agent-loop COMPLETE 验证守卫 + 步骤超限强制收口路径 + workunit 模块 `POST /workunits/:id/verify`

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
  - 子模块：`auditor-rules.js`、`auditor-execution.js`、`auditor-reports.js`
- 下游
  - **apps/api/src**（cli/server.ts、index.ts、route-registry.ts）—— API 入口挂载 agents 路由及启动时初始化
  - **apps/api/src/modules/knowledge**（internal.routes.ts、knowledge-service.ts）—— 知识模块依赖本目录的 knowledge-agent.service 等
  - **apps/api/src/modules/workunit**（waiting-input.ts）—— 等待输入流程引用 agent 实例

## 注意事项

- AgentLoop session token 限制为 100K（`SESSION_TOKEN_LIMIT`），超过后自动截断
- **AgentProfile 持久化布局**：`~/.studio/data/agents/{id}/profile.json`（身份：name/description/provider/status/nodeId，模型见 `packages/studio-shared/src/file-store.ts`，无 systemPrompt 字段）+ 同目录 `state.json`（运行时实例）；原子写 + mkdir 锁，永久存在仅可显式 DELETE；保留名 `studio`（系统执行角色，provider 由 StudioRoleSetupModal 补配）
- **prompt 注入架构 = index-on-demand（严禁全量注入）**：skills 走索引+按需（step 时匹配：相关度排序全量列表，2K 预算块级截断取代封顶 3；prompt 只放 name+description+triggers 摘要+`~/.studio/skills/<name>/SKILL.md` 绝对路径指针，正文不注入，agent 按需阅读，见 `agent-loop.ts` buildSkillSection）；知识分层（rule/context 约束层按设计全量、signal 层 `[id] summary` 索引、reference 层只报条数，见 knowledge-service.injectContext）；roster 只放 `name（provider）：description` 索引行且不含自身；全部注入共享 2K token 红线硬截断。不注入：agent 完整记录、频道列表、成员 ID、记忆
- A2A 协作 P1（2026-07-agent-to-agent-collab-design）：`ACTION: DELEGATE:@<profileName>:<scope>` 协议由 recordResult 拦截，经 workunit/delegation-gate 校验后建子单（`metadata.collab`）+ 发 delegate 卡片，拒绝则降级 NEED_INPUT；父 complete 守卫（未完结子 WU → 降级 progress）；发言层新鲜度检查（step 期间房间有外部新消息 → 结果帖拦截注入 pendingReplies，连续 2 次后照发）；花名册段（## 频道成员与委派）与 skill/知识段共用 2K 注入红线（优先级 skills > roster > knowledge）
- Idle 心跳间隔固定 45 秒（`IDLE_HEARTBEAT_INTERVAL_MS`），配合超时扫描 5 分钟阈值
- `AgentLoopRegistry.mount()` 幂等且不抛错，失败仅标记为 failed 状态
- 路由层统一使用 `getErrorMessage` 捕获异常，并返回标准错误码（如 `INTERNAL_ERROR`、`NOT_FOUND`）
- 所有 Agent 数据均通过 `FileStore` 存储（已从 Prisma 迁移）
- 审计日志写入 `~/.studio/logs/studio-events.jsonl` 文件
- `agent-profile.service.ts` 在创建 profile 时会发布 `agent-profile.created` 事件，由 `AgentLoopRegistry` 监听并自动挂载 loop
- **mention 派单调度链**：`WorkUnitService.create` 发 `workunit.created` 事件 → TriggerScheduler 唤醒对应 AgentLoop.observe（另有 15s 轮询兜底）→ 过滤（assigneeId 精确匹配 / 频道成员 / F4 `metadata.excludeAssignee` 排除实现者）→ claim（assigneeId 改写为 instance.id）→ agentStep → LocalExecutor → runner-lightweight spawn CLI → recordResult 解析 ACTION → postToDiscussionSpace 经 `ChannelMessageService.createAgentMessage`（绑定 loop 自身 fileStore 的实例，测试可注入临时 store）回帖（**2026-07-29 起走 EventBus/SSE**，此前直写 fileStore 不发事件，频道页只能轮询/刷新才能看到 agent 回复）
- **F4 review 派发（2026-07-28 分析文档决策 5）**：ReviewDispatcher 不再按 description 含 'reviewer' 找具名角色（字符串锚点已废除，`builtin-roles.ts` 已删除）——父 WU 进 in_review → 建 `assigneeId=null` 的未指派 review 子 WU 走 claim 涌现；实现者（assigneeId 两种形态：profile id / instance id→state.roleId）写入 `metadata.excludeAssignee` 禁止自领；频道内除实现者外无 active 成员（或 members 未回填）→ 自评兜底：不排除 + `metadata.selfReview=true` + 频道系统消息提醒人工复核
- **R3 评审输入契约（2026-07-28 分析文档 §4-R3）**：评审子 WU scope = diff-only + `+code-review` 点名——只审 `git diff <baseBranch>...HEAD`（实现叙述仅作背景定位）；上下文失效 `verdict=needs-info` → parseReviewReport 返回 null → 转人工（不猜不硬判）；`metadata.reviewInput` 落档审计。评审回传经 reviewPassed/reviewRejected 的 attestation 入参落父 WU 台账 l2（selfReview/ref 透传，F6 决策 1）
- **PMO 分析接力（2026-07-29）**：ReviewDispatcher 路径 A 跳过 `type='analysis'`（分析结论的评审 = 人工确认 F6 l3，diff-only 契约对非代码产物恒 needs-info 纯噪声；接力提示与派工见 pmo/analysis-handoff.ts）。analysis WU COMPLETE 时 agent-loop 用 `parseTaskBreakdown` 解析输出中的 `TASK: <任务描述>` 行（去重/封顶 ANALYSIS_TASKS_MAX=8/条 ≤300 字符）落 `metadata.analysisTasks`；契约写在 pmo/project.service.publish 的 analysis scope 里，人工「通过」后由 analysis-handoff 建未指派 task 子 WU 派工
- **F6 台账 l1（决策 1）**：COMPLETE 前自动验证守卫同时写 `metadata.attestations.l1`（approved/rejected 都落，by=profile id）
- **F6-c 证据断链修复（2026-07-30）**：①验证逻辑抽出 `wu-verification.ts`（见核心导出）；②**步骤超限强制收口补跑 L1**——COMPLETE 守卫只在 action=complete 时跑，超限路径（任意 action）此前完全跳过验证，强制 in_review 的代码类 WU 永远缺 l1；现在收口前对代码类 + 有 worktree 的 WU 补跑一次（本 step 守卫已跑则不重复），台账写法同守卫但不计 verifyFailCount、不改 blocked 语义；③`POST /workunits/:id/verify` 人工重跑 L1（human-only，只动台账不动状态，见 workunit/CONTEXT.md）；④`POST /workunits/:id/dispatch-review` 人工补派评审（`ReviewDispatcher.dispatchReviewNow`，复用路径 A 建单逻辑；守卫：type≠review/analysis、status∈in_review/done、deriveDisplayState 判定 l2 未达成、有频道、无在途评审子 WU）+ handleReviewChildDone 放宽——父已被人工直推 done 且 l2 缺失时，迟到 approved 经 reviewPassed F6-c 幂等口补写 l2（不动状态；迟到 rejected 不打回人工收口的 WU，频道转人工复核）。幂等补写证据后发 status_changed（状态值不变也发）让 pmo rollup 重估。**纪律：验证失败只落 l1 rejected，绝不写 verifyReport**（metrics 按 verifyReport 存在计通过，失败写入会虚增通过率）
- **isOnline 语义（2026-07-27 起）** = loop 存活：state status 为 idle/active 且心跳新鲜（≤5min，与 agent-timeout-scan 同阈值；null 心跳按 startedAt 宽限）。另知一坑（未修）：手动 `POST /agent-instances` 只建 idle 记录、并不起 loop，null 心跳约 2 分钟内被 timeout-scan 终止（假在线）
- **多实例单活（2026-07-30 走查修复）**：同一 `~/.studio` 被多 api 实例共享时（本机 dev:13001 / prod:13101 并存），`STUDIO_AGENT_LOOP_ENABLED=false` 的实例 standby——index.ts 不注册系统触发器（含定时 WU 创建）不挂载 loop，但保留 ReviewDispatcher/AnalysisHandoff/事件桥订阅（状态变更由谁发起就在谁进程内触发，两侧都有幂等哨兵）。此外 `AgentLoop.start()` 内置同角色单活守卫：另一进程持有的活实例（异 pid 存活 + 心跳/启动时间 <120s 新鲜）存在时 standby 返回 false 并记 error 状态（message 含「活实例」），持有者退出后重启即接管；AC-4.6 stale 清理只管死 pid，管不了双活进程
- **ReviewDispatcher 子 WU 不继承会话簿记（2026-07-30 走查修复）**：review 子 WU metadata 原样 spread 父 WU 会带上 `sessionId` 等字段 → 子 WU 误续用父 WU 的 CLI 会话（违反「同一 WU 内才续用」，异 cwd 必失败；root 下 `--resume` 还会触发 CLI 自注入 `--dangerously-skip-permissions` 被 root guard 秒拒 exit 1）。createReviewWorkUnit 现显式 delete：sessionId/startedAt/sessionResumes/stepCount/consecutiveStuck/errorType/errorDetail/errorAt/_cumulativeTokens/lastInputTokens；pmoId/pmoNumber 等域血缘保留
- **鉴权（2026-07-24 收紧）**：legacy agents POST `/`、PUT `/:agentId` 与 agent-profiles/agent-instances 写 = `requireAuth()+requireNotGuest()`；`POST /review/diff`（任意路径写+spawn claude）与 instances `POST /:id/terminate` = `requireAuth()+requireAdmin()`；legacy DELETE 原有 requireRole('Admin') 不变。另知：agent-configs `:id` 路径拼接无校验（穿越面，未修）、/review/diff 的 baseRef/headRef shell 拼接（Admin 门后，未修）

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-30: F6-c WorkUnit 三层证据断链修复 — 新增 `wu-verification.ts`（agent-loop 验证守卫逻辑原样抽出：CODE_WORKTREE_TYPES/resolveVerifyCommands/runWuVerification/extractExecOutputTail）；agent-loop 步骤超限强制收口路径补跑 L1（断点 1：此前强制 in_review 的代码类 WU 永远缺 l1）；review-dispatcher 增 `dispatchReviewNow` 人工补派评审 + handleReviewChildDone 放宽至 done 父 WU 幂等补写 l2（断点 3）；配套 workunit 两个 human-only 端点见 workunit/CONTEXT.md
- ✅ `280a7329`: PMO 走查修复 — agent 执行可靠性 + 多实例单活 + 链路优化
- ✅ 2026-07-28: F1+F4+seed 退役（2026-07-28 分析文档，决策 5/6）— 新增 `default-provider.ts`（provider 缺省打戳 + 启动回填，替代 null+隐式 claude 兜底）；ReviewDispatcher 解锚（评审子 WU 未指派涌现 + excludeAssignee 排除实现者 + 自评兜底 selfReview 标记，不再依赖 description 含 'reviewer'）；agent-loop observe 未指派过滤新增 excludeAssignee 剔除；删除 `builtin-roles.ts`（pm/dev/reviewer 内置 seed 三函数，角色创建走用户入口/preset 模板 `.agents/roles/*.yaml`）
- ✅ `01c2ee93`: CI 脆弱点 — STUDIO_EVENTS_JSONL 可覆盖 + 测试事件隔离
- ✅ 2026-07-24: API 鉴权收紧 — agents/profiles/instances 写端点收 requireNotGuest，/review/diff 与 terminate 收 requireAdmin
- ✅ 2026-07 频道角色排查沉淀：AgentProfile 持久化布局与 index-on-demand 注入架构写入注意事项（排查结论：无全量注入问题，skills/知识/roster 均为索引方式）
- ✅ `11ba99fa`: ci): resolve type errors in migrated agent/knowledge files
- ✅ `13f60e68`: db-removal): migrate 9 more files from Prisma → FileStore (Round 2)
- ✅ `1773bfdf`: db-removal): migrate 11 files from Prisma → FileStore (59 calls eliminated)
- ✅ `b85449b1`: db-removal): final sweep — 全仓库 prisma 引用清零
- ✅ `c3b1aab8`: channel-an): resolve 7 code review warnings
- ✅ `f06ebafe`: agents): AgentLoop channelId filter — JSON.parse double-encode guard
- ✅ `93f20262`: agents): tryClaim revert to direct prisma + poll-fallback cron fix
- ✅ `a8970c03`: agents): remove redundant as WorkUnit cast in agent-loop.ts L114
- ✅ `f83bc026`: agents): AgentLoop→WorkUnitService + TriggerScheduler singleton
- ✅ `4a0760ae`: agents): default-triggers 3 bug 修复
- ✅ `5dbe148d`: daemon): pass config.timeoutMs through to agent-runner (B57-P3)
- ✅ `f7ddf542`: pipeline LLM output resilience — JSON sanitize + deterministic gate
- ✅ `0fbbc2ef`: B55 管线 Session 隔离 + Analyst 健壮性 + SDD 清理
- ✅ `66228b3f`: architectureContext 质量闭环 — 统一 Analyst 产出 + 修正 Gate 检查层
- ✅ `e8dd9df7`: B52 per-execution session + 空 diff 预检 + 监控点 1-4
- ✅ `732e6396`: 补全 12 监控点数据缺口 — 支撑 O2-KR2 缓存优化决策
- ✅ `fe88e333`: Deploy 仓库选择 #19 — REPO_DIR env 优先于 DB WorkspaceRepo
- ✅ `c386e578`: AuditorAgent logger + KnowledgeBus orphan cleanup + retry cap
- ✅ `4a70a2e6`: reviewer 400 — remove --model flag + pipelineReview upsert
- ✅ `e59e6f4f`: review persistence — PipelineReview write + StudioEvent + catch approved:false
- ✅ `13cf6b7e`: deploy failure event enrichment + metricType registration
- ✅ `1c4ac168`: SP-004): 补齐 SDD 三个缺口 — Files section + Analyst 输出 + 去 DB 读
- ✅ `c0beddbd`: B38 错误日志修复 + GAP-7 元数据驱动注入
- ✅ `309f6061`: review pipeline — diff scope + discoveredIssues exposure
- ✅ `556051f2`: B34 behavior distillation output path + PatternMiner startup + agent-runner --verbose
- ✅ `1c4bb9ae`: remove all hardcoded credentials — require env vars
- ✅ `79f4a18tion output path + PatternMiner startup + agent-runner --verbose
- ✅ `1c4bb9ae`: remove all hardcoded credentials — require env vars
- ✅ `79f4a186`: knowledge quality gate + CPU monitoring + type fix
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
- ✅ `9dec006c`: 管线自举根因修复 — AC 质量 + Gate 加固 + OKR v3
- ✅ `8d4bb203`: auditor): 知识库路径统一到 ~/.studio/knowledge/
- ✅ `7ab11eb8`: knowledge sync pipeline — auto-sync to vector DB after ingest
- ✅ `d073972f`: preflight 磁盘检查 + 孤儿进程清理 + roadmap B14 启动流水线
- ✅ `79c3de0a`: knowledge): B13 飞轮闭环 — Resolution→local-rag + 行为趋势 + maturity 排序
- ✅ `62cf3d37`: knowledge): B13-009 — OpsAgent 关键失败写入 KnowledgeBus
- ✅ `958e433f`: knowledge): B13-002 — Triage resolve 时回写 Resolution
- ✅ `456cf62f`: knowledge): B13-001 — verifyResolution 接线到 Triage/Deploy
- ✅ `b2bf3f63`: branch cleanup gap — delete source after merge + clean daemon/worktree branches
- ✅ `7ab15321`: use ANTHROPIC_AUTH_TOKEN as fallback for knowledge extraction
- ✅ `ce7c3955`: knowledge extraction JSON parse failure + localeCompare crash
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
- ✅ `e82b47e6`: 知识飞轮自动闭环 — 消除 ingest 手动标记 + Auditor Circuit #8
- ✅ `78c6856d`: Prisma SQLite auto-parses JSON String fields — handle both string and object
- ✅ `7d5b0fda`: Phase 0 — 7 Critical bugs in pipeline quality gates and concurrency
