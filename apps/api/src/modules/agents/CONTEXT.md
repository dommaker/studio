# agents

> 此文件描述 apps/api/src/modules/agents 目录的职责和上下文

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
- `executor.ts` — §9.6 Executor 接口（AgentLoop 执行面抽象）：P0 `LocalExecutor` 原样委托 `agentRunner.executeLightweight`；P1 远程节点执行经同一接口接入

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
- **prompt 注入架构 = index-on-demand（严禁全量注入）**：skills 走 4 层索引（claim 匹配 ≤3 存名 → prompt 只放 name+一句话描述+`.studio/skills/<name>/SKILL.md` 指针 → worktree AGENTS.md 索引行 → 全文落盘按需阅读，见 `agent-loop.ts` buildSkillSection / `studio-agent/worktree-resolver.ts`）；知识分层（rule/context 约束层按设计全量、signal 层 `[id] summary` 索引、reference 层只报条数，见 knowledge-service.injectContext）；roster 只放 `name（provider）：description` 索引行且不含自身；全部注入共享 2K token 红线硬截断。不注入：agent 完整记录、频道列表、成员 ID、记忆
- A2A 协作 P1（2026-07-agent-to-agent-collab-design）：`ACTION: DELEGATE:@<profileName>:<scope>` 协议由 recordResult 拦截，经 workunit/delegation-gate 校验后建子单（`metadata.collab`）+ 发 delegate 卡片，拒绝则降级 NEED_INPUT；父 complete 守卫（未完结子 WU → 降级 progress）；发言层新鲜度检查（step 期间房间有外部新消息 → 结果帖拦截注入 pendingReplies，连续 2 次后照发）；花名册段（## 频道成员与委派）与 skill/知识段共用 2K 注入红线（优先级 skills > roster > knowledge）
- Idle 心跳间隔固定 45 秒（`IDLE_HEARTBEAT_INTERVAL_MS`），配合超时扫描 5 分钟阈值
- `AgentLoopRegistry.mount()` 幂等且不抛错，失败仅标记为 failed 状态
- 路由层统一使用 `getErrorMessage` 捕获异常，并返回标准错误码（如 `INTERNAL_ERROR`、`NOT_FOUND`）
- 所有 Agent 数据均通过 `FileStore` 存储（已从 Prisma 迁移）
- 审计日志写入 `~/.studio/logs/studio-events.jsonl` 文件
- `agent-profile.service.ts` 在创建 profile 时会发布 `agent-profile.created` 事件，由 `AgentLoopRegistry` 监听并自动挂载 loop
- **鉴权（2026-07-24 收紧）**：legacy agents POST `/`、PUT `/:agentId` 与 agent-profiles/agent-instances 写 = `requireAuth()+requireNotGuest()`；`POST /review/diff`（任意路径写+spawn claude）与 instances `POST /:id/terminate` = `requireAuth()+requireAdmin()`；legacy DELETE 原有 requireRole('Admin') 不变。另知：agent-configs `:id` 路径拼接无校验（穿越面，未修）、/review/diff 的 baseRef/headRef shell 拼接（Admin 门后，未修）

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
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
