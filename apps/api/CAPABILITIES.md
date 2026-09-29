# CAPABILITIES.md

> 最后更新: 2026-09-29

---

| 模块 | 文件 | 说明 |
|------|------|------|
| app | src/app.ts | 注册所有 API 路由（异步，启动时调用一次） |
| studio-cli | src/cli/studio-cli.ts | Studio CLI — 统一入口（2026-05-09: Docker/tmux 已移除） |
| cli-scanner | src/daemon/cli-scanner.ts | CLI Scanner — auto-detect available agent CLIs on the system |
| api-cache | src/middleware/api-cache.ts | API 缓存中间件 — 内存 Map |
| audit-logger | src/middleware/audit-logger.ts | 审计日志中间件 - Audit Logger Middleware |
| auth | src/middleware/auth.ts | 认证中间件 - Auth Middleware |
| error-handler | src/middleware/error-handler.ts | 错误处理中间件 |
| rate-limit | src/middleware/rate-limit.ts | Rate Limiting Middleware |
| request-logger | src/middleware/request-logger.ts | 请求日志中间件 |
| docs-freshness.routes | src/modules/admin/docs-freshness.routes.ts | T-020 + T-059: CLAUDE.md + CAPABILITIES.md Freshness Check |
| auditor.service | src/modules/agents/auditor/auditor.service.ts | Auditor Service — 跨任务审计 + 周期洞察 |
| knowledge-curator.service | src/modules/agents/knowledge/knowledge-curator.service.ts | Knowledge Curator - 知识库冷启动 + F1 每日维护 + 提取 prompt 单一来源 |
| monitor.service | src/modules/agents/monitor/monitor.service.ts | Monitor Service - 健康监控 + NA Step 7 渐进告警 |
| ops.service | src/modules/agents/ops/ops.service.ts | Ops Service — 系统生命周期守护 |
| ops-rules | src/modules/agents/ops/ops-rules.ts | Ops Rules — 运行时数据，不在代码里 |
| routes | src/modules/agents/routes.ts | Agent API 路由 |
| session-summary.service | src/modules/agents/session-summary.service.ts | SessionSummaryService — 会话级知识提取 (2026-05-25) |
| triage.service | src/modules/agents/triage/triage.service.ts | Triage Service — incident response: diagnose → classify → act → resolve/escalate |
| types | src/modules/agents/types.ts | Agent 团队类型定义 |
| routes | src/modules/audit-logs/routes.ts | GET /api/audit-logs - 查询审计日志 |
| routes | src/modules/auth/routes.ts | POST /api/v1/auth/guest-session |
| service | src/modules/auth/service.ts | 认证服务 - Auth Service |
| routes | src/modules/builtin-tools/routes.ts | builtin-tools/routes.ts — Built-in Toolset (HZ-026) |
| channel-init | src/modules/channels/channel-init.ts | Seed default channels on startup (B1-001) |
| channel-message.service | src/modules/channels/channel-message.service.ts | ChannelMessage Service — centralized message creation + event publishing |
| channel.routes | src/modules/channels/channel.routes.ts | Channel Routes — B1-001/B1-002/B1-009/B1-011 |
| routes | src/modules/dingtalk/routes.ts | 钉钉机器人交互回调 |
| command-runner | src/modules/discord/command-runner.ts | B3-002/B3-003: Shared command runner for CLI and Discord |
| routes | src/modules/discord/routes.ts | Discord Interactions Endpoint |
| event.routes | src/modules/events/event.routes.ts | G30: StudioEvent API Endpoints |
| session-summary-generator | src/modules/events/session-summary-generator.ts | B9-015: SessionSummaryGenerator — server-side session aggregation |
| sse.routes | src/modules/events/sse.routes.ts | HZ-028: Event Stream (SSE) |
| routes | src/modules/executions/routes.ts | Execution API 路由 |
| iron-laws.routes | src/modules/harness/iron-laws.routes.ts | Iron Laws API — 从 runtime-proxy 迁移 (2026-05-14) |
| routes | src/modules/harness/routes.ts | FL-029: Harness Monitoring Routes (T-015) |
| decision-chain-extractor | src/modules/knowledge/decision-chain-extractor.ts | DecisionChainExtractor (G-004) — 从 Meeting 辩论 + Goal 执行中提取决策链 |
| unified-query | src/modules/knowledge/engine/unified-query.ts | UnifiedQuery — dual-store unified query layer. |
| env-snapper | src/modules/knowledge/env-snapper.ts | EnvSnapper (G-003) — 系统环境自动快照 |
| eval-case-generator | src/modules/knowledge/eval-case-generator.ts | EvalCaseGenerator — Better-Harness hill-climbing 吸收 |
| evolution-scheduler | src/modules/knowledge/evolution-scheduler.ts | Knowledge Evolution Scheduler |
| knowledge-singletons | src/modules/knowledge/knowledge-singletons.ts | 知识共享单例唯一所有者 + 向量库同步 + 统一质量门（#343 起 KnowledgeBus 兼容壳删除） |
| knowledge-query.service | src/modules/knowledge/knowledge-query.service.ts | KnowledgeQueryService (S8) — 统一知识检索入口 |
| knowledge-service.routes | src/modules/knowledge/knowledge-service.routes.ts | KnowledgeService HTTP API + SSE |
| knowledge-service | src/modules/knowledge/knowledge-service.ts | KnowledgeService — Unified knowledge capability layer |
| knowledge-sync.service | src/modules/knowledge/knowledge-sync.service.ts | KnowledgeSync — 自运转知识同步系统 |
| pattern-miner | src/modules/knowledge/pattern-miner.ts | PatternMiner (G-005) — 从 MCP traces + 审查历史中挖掘交互模式 |
| preference-observer | src/modules/knowledge/preference-observer.ts | PreferenceObserver (G-001) — 从 MCP traces + 路由反馈中推断用户偏好 |
| resolution.service | src/modules/knowledge/resolution.service.ts | ResolutionService — RKB 匹配/创建/验证 |
| routes | src/modules/knowledge/routes.ts | 知识库 API - 公司数字资产管理 |
| rule-scanner | src/modules/knowledge/rule-scanner.ts | RuleScanner (G-002) — 从源码/harness 约束/配置中提取业务规则 |
| routes | src/modules/lark/routes.ts | 飞书机器人交互回调 |
| admin.routes | src/modules/mcp/admin.routes.ts | MCP Admin Routes — tool management, permissions, audit |
| permission.service | src/modules/mcp/permission.service.ts | MCP Permission Service — role×tool access control + audit logging |
| routes | src/modules/mcp/routes.ts | MCP HTTP Routes |
| server | src/modules/mcp/server.ts | MCP Server - Model Context Protocol 服务器 |
| tool-registry | src/modules/mcp/tool-registry.ts | MCP Tool Registry — dynamic registration, health, rate limiting |
| tools | src/modules/mcp/tools.ts | MCP Tools 定义 |
| routes | src/modules/notifications/routes.ts | 通知 API 路由 |
| notify.service | src/modules/outbound-notify/notify.service.ts | NotifyService - 通知服务 |
| routes | src/modules/outbound-notify/routes.ts | Notify API 路由 |
| okr.service | src/modules/pmo/okr.service.ts | 🆕 AS-016: 获取当前季度 |
| project.service | src/modules/pmo/project.service.ts | Project Service - PMO 项目管理 |
| routes | src/modules/pmo/routes.ts | GET /api/v1/pmo/project |
| routes | src/modules/skills/routes.ts | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| skill-loader | src/modules/skills/skill-loader.ts | SkillLoader API Service — DB-driven skill loading with session lifecycle |
| routes | src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| skill-extraction.service | src/modules/skills/skill-extraction.service.ts | Skill Extraction Service — 面向新架构 GoalExecution |
| skill-proposal-routes | src/modules/skills/skill-proposal-routes.ts | Skill Proposal API 路由 |
| error-class | src/modules/triage/error-class.ts | Triage ErrorClass — B1-007: 八类错误标签 + 严重度三级 + 策略路由 |
| library.routes | src/modules/library/library.routes.ts | GET /api/v1/library（只读，无写端点）|
| local-workspace | src/modules/workspaces/local-workspace.ts | Local Workspace Registration — AS-020 P2-04 |
| workspace.routes | src/modules/workspaces/workspace.routes.ts | Workspace Routes — 本机 workspace 记录只读/删除 + 本机 CLI 清单 |
| route-registry | src/route-registry.ts | Route Registry - 模块化路由注册 |
| seed-skills | src/scripts/seed-skills.ts | Seed 4 built-in Skills into the Skill table (D6). |
| discord-notifier | src/utils/discord-notifier.ts | Discord 通知工具 |
| errors | src/utils/errors.ts | errors |
| logger | src/utils/logger.ts | Logger 工具 |
| pagination | src/utils/pagination.ts | 分页工具 - 统一 API 分页参数解析和响应格式 |
| services | src/utils/services.ts | 创建懒加载单例服务 |
| agent-instance.routes | src/modules/agents/agent-instance.routes.ts | RuntimeInstance API 路由 (AS-026 AC-1) |
| agent-instance.service | src/modules/agents/agent-instance.service.ts | AgentInstance Service — RuntimeInstance CRUD |
| agent-loop | src/modules/agents/loop/agent-loop.ts | Analyze agent log for knowledge search behavior. |
| agent-profile.routes | src/modules/agents/agent-profile.routes.ts | AgentProfile API 路由 (AS-025 Phase 2) |
| agent-profile.service | src/modules/agents/agent-profile.service.ts | AgentProfile Service — 简化 Agent 身份 CRUD |
| default-triggers | src/modules/agents/default-triggers.ts | Default Triggers — 6 system triggers for Agent Network |
| eval-case-store | src/modules/knowledge/eval-case-store.ts | EvalCaseStore — File-based CRUD for eval cases |
| monitoring.routes | src/modules/monitoring/monitoring.routes.ts | Monitoring Routes — Agent Network (MVP-2 + MVP-6) |
| monitoring.service | src/modules/monitoring/monitoring.service.ts | Monitoring Service — Agent Network aggregation (MVP-2 + MVP-6) |
| manifest-loader | src/modules/skills/manifest-loader.ts | manifest-loader (AS-025 3.28c-5) |
| skill-selector | src/modules/skills/skill-selector.ts | skill-selector (AS-025 3.28c-5) |
| skill-store | src/modules/skills/skill-store.ts | SkillStore — File-based CRUD for Skill metadata |
| cron-matcher | src/modules/triggers/cron-matcher.ts | Cron Matcher — minimal cron expression evaluator (3.28c-4) |
| trigger-action | src/modules/triggers/trigger-action.ts | Execute a CREATE action — creates a WorkUnit from trigger payload. |
| trigger-registry | src/modules/triggers/trigger-registry.ts | Trigger Registry — singleton TriggerScheduler instance |
| trigger-scheduler | src/modules/triggers/trigger-scheduler.ts | Register a trigger programmatically. |
| trigger-store | src/modules/triggers/trigger-store.ts | Trigger Store — YAML-based trigger config persistence (3.28c-4) |
| trigger.routes | src/modules/triggers/trigger.routes.ts | Trigger Routes — REST API for trigger management (3.28c-4) |
| trigger.types | src/modules/triggers/trigger.types.ts | Trigger Registry Types (3.28c-4, AS-026 extended) |
| library.service | src/modules/library/library.service.ts | Library service — 跨仓 .studio/ 聚合只读 |
| workunit.routes | src/modules/workunit/workunit.routes.ts | WorkUnit API 路由 (AS-025 §3.28c-1, §5.16) |
| workunit.service | src/modules/workunit/workunit.service.ts | WorkUnit Service — 工作单元 CRUD + Claim + 状态机 |
| admin | src/cli/admin.ts | ── 管理域（2026-07-20 自 studio-cli.ts 按命令域拆分）── |
| bootstrap | src/cli/bootstrap.ts | bootstrap — studio run web / studio up 共用的数据目录与密钥自举（#571） |
| config | src/cli/config.ts | ── 配置域（2026-07-20 自 studio-cli.ts 按命令域拆分）── |
| data | src/cli/data.ts | studio knowledge 入口：upsert / sync-status 走内部端点（harness#110 前置①， |
| dev | src/cli/dev.ts | Get admin token for authenticated API calls. |
| first-run-panel | src/cli/first-run-panel.ts | first-run-panel — studio run web 首启检测块（#571） |
| mcp-install | src/cli/mcp-install.ts | ── studio mcp install（#566 P3）── |
| port-probe | src/cli/port-probe.ts | port-probe — studio run web 端口探测与动态顺延（#571） |
| run-web | src/cli/run-web.ts | ── studio run web：npm 本地形态一体起服务总入口（#571）── |
| server | src/cli/server.ts | ── 服务管理域（2026-07-20 自 studio-cli.ts 按命令域拆分）── |
| shared | src/cli/shared.ts | ── CLI 共享常量与助手（2026-07-20 自 studio-cli.ts 按命令域拆分）── |
| skill-validate | src/cli/skill-validate.ts | skill-validate — skill 目录布局 + frontmatter 离线校验（#568） |
| skill | src/cli/skill.ts | studio skill validate/export/install — skill 流动三件套（#568） |
| workflow | src/cli/workflow.ts | ── 审批域（2026-07-20 自 studio-cli.ts 按命令域拆分）── |
| cors-origin | src/cors-origin.ts | CORS Origin 白名单判定（2026-08-25 安全收口）。 |
| compression-filter | src/middleware/compression-filter.ts | Compression filter (#263) |
| action-center.service | src/modules/action-center/action-center.service.ts | 行动中心派生服务（#468 统一行动中心）。 |
| routes | src/modules/action-center/routes.ts | 行动中心 API 路由（#468） |
| agent-knowledge-analysis | src/modules/agents/agent-knowledge-analysis.ts | Analyze agent log for knowledge search behavior. |
| auditor-execution | src/modules/agents/auditor/auditor-execution.ts | Auditor Agent — 建议执行 / 升级 / 闭环 |
| auditor-reports | src/modules/agents/auditor/auditor-reports.ts | Auditor Agent — 洞察与报告输出 |
| auditor-rules | src/modules/agents/auditor/auditor-rules.ts | Auditor Agent — 审计规则（检测 → 建议） |
| review-adapter | src/modules/agents/auditor/review-adapter.ts | review-adapter (#356) — auditor_suggestion 提案卡 adapter（接线 review-proposal 正本） |
| default-provider | src/modules/agents/default-provider.ts | F1 provider 默认选取工具（2026-07-28 内置角色与信任模型分析，决策见 |
| dispatch-reconciliation | src/modules/agents/dispatch-reconciliation.ts | #183 派工/评审断链 5min 对账扫描（dispatch-reconciliation-scan handler 本体）。 |
| instance-timeout-scan | src/modules/agents/instance-timeout-scan.ts | #179（#66 决议 3 scan 侧）agent-timeout-scan handler 本体。 |
| knowledge-cold-start | src/modules/agents/knowledge/knowledge-cold-start.ts | Knowledge Agent — 冷启动子模块 |
| knowledge-extraction | src/modules/agents/knowledge/knowledge-extraction.ts | Knowledge Agent — 提取 prompt 单一来源 |
| knowledge-maintenance | src/modules/agents/knowledge/knowledge-maintenance.ts | Knowledge Agent — 语料分析（每日维护）子模块 |
| agent-loop-events | src/modules/agents/loop/agent-loop-events.ts | 非缓存执行 tokens（CLI usage input+output，不含 cache）。CLI 未回报 usage 时传 null —— |
| agent-loop-guards | src/modules/agents/loop/agent-loop-guards.ts | AgentLoop 守卫函数区（2026-08 工单 28 从 agent-loop.ts 原样抽出，行为不变）： |
| agent-loop-parsers | src/modules/agents/loop/agent-loop-parsers.ts | #467：解析 NEED_INPUT 后续的 RULING: JSON 行（plan 裁决轮契约，见 prompt-composer |
| agent-loop-registry | src/modules/agents/loop/agent-loop-registry.ts | #634: provider 变更重挂入口——同一 profile 的多次变更串行排队（上一环失败不阻塞后续）， |
| agent-loop.types | src/modules/agents/loop/agent-loop.types.ts | AgentLoop 类型契约（2026-08 工单 28 从 agent-loop.ts 原样抽出，行为不变）： |
| claim-fitness | src/modules/agents/loop/claim-fitness.ts | 认领前适任判断（决策 14，docs/adr/2026-08-25-review-independence-trust-model.md 补充段）。 |
| completion-gates | src/modules/agents/loop/completion-gates.ts | 收口守卫链（2026-08 从 agent-loop.recordResult 抽出，行为一字不改）： |
| completion-harvest | src/modules/agents/loop/completion-harvest.ts | per-WU-type COMPLETE 收割注册表（#542，2026-09-15 架构评审候选 A2） |
| context-overflow | src/modules/agents/loop/context-overflow.ts | #96: CLI 上下文溢出纯反应式策略 —— 溢出错误识别 + 会话滚动摘要构建（纯函数，零服务依赖）。 |
| daily-token-budget | src/modules/agents/loop/daily-token-budget.ts | C3（2026-08-03 unattended-token-burn issue P2-2，决策记录 #4）：每日 token 预算熔断。 |
| delegate-branch | src/modules/agents/loop/delegate-branch.ts | A2A §4.1 DELEGATE 分支（2026-08 从 agent-loop.recordResult 抽出，行为一字不改）： |
| execution-step-events | src/modules/agents/loop/execution-step-events.ts | 执行步事件（WU 过程可视化） |
| executor | src/modules/agents/loop/executor.ts | §9.6 Executor 接口 — AgentLoop 执行面抽象（P0） |
| lease-heartbeat | src/modules/agents/loop/lease-heartbeat.ts | #178（2026-08-16，#63 决议 1/2）WU 租约心跳。 |
| prompt-composer | src/modules/agents/loop/prompt-composer.ts | prompt/上下文组装（2026-08 从 agent-loop.agentStep 抽出）： |
| review-contract | src/modules/agents/loop/review-contract.ts | Review Contract — 审查结论（verdict）语义的单一来源 |
| review-dispatcher | src/modules/agents/loop/review-dispatcher.ts | ReviewDispatcher - AC-4.1 ~ AC-4.5: 状态机驱动的 review 系统代派 |
| session-resume | src/modules/agents/loop/session-resume.ts | #94 会话续用判定（会话号 per-WU 化）：纯函数，零服务依赖。 |
| step-guards | src/modules/agents/loop/step-guards.ts | 入口守卫链（#541，2026-09 从 agent-loop.agentStep 头部原样抽出，行为一字不改， |
| step-retry-policy | src/modules/agents/loop/step-retry-policy.ts | 步执行重试策略（#543，2026-09 架构评审 A3）：收编 agentStep 中段两段孪生重试骨架 —— |
| wu-lease | src/modules/agents/loop/wu-lease.ts | #209 smell 4（源自 #178 / #63 决议 1/2）：WU 租约追踪器。 |
| wu-verification | src/modules/agents/loop/wu-verification.ts | B3b-i（决策 D3 前半）WU 自动验证 —— 从 agent-loop 抽出的可复用实现（2026-07-30 F6-c 断链修复）。 |
| exec-async | src/modules/agents/monitor/exec-async.ts | monitor 轮内异步子进程包装（#374）——monitor 轮禁止同步 execSync/execFileSync |
| monitor-alerts | src/modules/agents/monitor/monitor-alerts.ts | Monitor Agent — 告警分发 / Triage 升级 / 事件写入 |
| monitor-lifecycle | src/modules/agents/monitor/monitor-lifecycle.ts | Monitor Agent — G31 数据生命周期：知识沉淀闸门 + TTL 清理 |
| monitor-probes | src/modules/agents/monitor/monitor-probes.ts | Monitor Agent — 任务/WorkUnit 级探测 |
| monitor-reports | src/modules/agents/monitor/monitor-reports.ts | Monitor Agent — 报告：轨迹评估 / 每日洞察 / 交互模式观察 |
| monitor-system-probes | src/modules/agents/monitor/monitor-system-probes.ts | Monitor Agent — 系统/知识级探测与自修复 |
| proc-probes | src/modules/agents/ops/proc-probes.ts | /proc 系统探测单出口 — 零子进程（无 execSync，不阻塞事件循环） |
| system-health | src/modules/agents/ops/system-health.ts | 系统健康采集模块（纯代码，零 LLM） |
| routes | src/modules/agents/routes.ts | Agent API 路由 |
| system-executor | src/modules/agents/system-executor.ts | SystemExecutor - 系统级 LLM 调用执行器（AC-1.6 ~ AC-1.10） |
| system-role | src/modules/agents/system-role.ts | 系统角色身份断言（#631）——「是不是系统角色」的唯一判定点。 |
| token-usage.routes | src/modules/agents/token-usage.routes.ts | §10.5 角色级 token 视图路由（只读）。 |
| token-usage.service | src/modules/agents/token-usage.service.ts | §10.5 角色级 token 滚动视图（只读聚合）。 |
| incident-notification | src/modules/agents/triage/incident-notification.ts | incident 落通知（#468 行动中心）：incident.created/escalated 处理点同步写 |
| incident-store | src/modules/agents/triage/incident-store.ts | incident-store（#255）— incidents.jsonl append-only 存储语义 |
| wu-test-guards | src/modules/agents/wu-test-guards.ts | B2 测试特征 WU 守卫（2026-08-03 token-burn issue P0-1c）—— 从 agent-loop.ts 原样抽出，行为不变。 |
| agent-decision | src/modules/audit-logs/agent-decision.ts | audit-logs/agent-decision (#591 B 类) — agent 自主决策埋点统一入口 |
| proposal-source | src/modules/audit-logs/proposal-source.ts | audit-logs/proposal-source (#591 A 类) — review-proposal 正本的聚合读面 |
| routes | src/modules/audit-logs/routes.ts | GET /api/audit-logs - 查询审计日志 |
| routes | src/modules/auth/routes.ts | GET /api/v1/auth/status |
| service | src/modules/auth/service.ts | 认证服务 - Auth Service |
| routes | src/modules/builtin-tools/routes.ts | builtin-tools/routes.ts — Built-in Toolset (HZ-026) |
| attachments | src/modules/channels/attachments.ts | 频道消息图片附件（2026-09，「频道里加上截图」，docs/plans/2026-09-channel-attachments.md） |
| channel.service | src/modules/channels/channel.service.ts | F6: 归一化 + 校验 defaultWorkspaceId（channel PATCH 用）。 |
| convert-to-task.service | src/modules/channels/convert-to-task.service.ts | AC-E2: Convert to Task Service |
| current-pmo | src/modules/channels/current-pmo.ts | #272（决策 #251 Q1/Q6）：频道「当前 PMO」派生。 |
| file-ref-vocabulary | src/modules/channels/file-ref-vocabulary.ts | #281（决策 #249 §1 / #257 D7）：@文件引用词表服务。 |
| message-routing | src/modules/channels/message-routing.ts | Message routing logic for channel messages (AC-B1-B4). |
| migrate-members | src/modules/channels/migrate-members.ts | §9.5 成员关系统一 — 迁移：把各 profile.channels 合并进对应 channel.members。 |
| pmo-candidates | src/modules/channels/pmo-candidates.ts | #638：频道 PMO 候选补全派生（`#` 触发自动补全弹框的数据源）。 |
| routing | src/modules/channels/routing.ts | #466: 频道级「阶段→角色」路由表 —— 单一解析/校验事实源。 |
| suggestions | src/modules/channels/suggestions.ts | #443（spec #441 情境引导 02）：频道建议推导骨架 —— 只读状态说明（status 形态）端到端。 |
| routes | src/modules/companies/routes.ts | Company API 路由 |
| webhook.routes | src/modules/deploy/webhook.routes.ts | Deploy Webhook — GitHub push 事件触发的部署入口（触发式部署，替代每分钟轮询的主通道） |
| routes | src/modules/dingtalk/routes.ts | 钉钉机器人交互回调 |
| routes | src/modules/discord/routes.ts | Discord Interactions Endpoint |
| distill-landings | src/modules/distill/distill-landings.ts | distill-landings (#145) — 蒸馏产物分类落地的两个通道实现（运行时装配见 distill-runtime）。 |
| distill-runs | src/modules/distill/distill-runs.ts | distill-runs (#351) — 蒸馏运行记录持久化（runs.jsonl） |
| distill-runtime | src/modules/distill/distill-runtime.ts | distill-runtime (#143) — 蒸馏模块运行时装配（唯一 import knowledge-singletons 的文件） |
| distill-service | src/modules/distill/distill-service.ts | distill-service (#143) — 蒸馏主链路最小闭环（#83 D1/D2/D5 落地，spec #141） |
| distill-threshold | src/modules/distill/distill-threshold.ts | distill-threshold (#143) — 蒸馏门槛检测纯函数（#83 D1 / spec #141） |
| gc-candidates | src/modules/distill/gc-candidates.ts | gc-candidates (#144) — GC 候选清单周期计龄纯函数（#83 D4 / spec #141） |
| review-adapters | src/modules/distill/review-adapters.ts | review-adapters (#351) — distill 域两个人审提案卡 adapter（接线 review-proposal 正本） |
| lock-events-bridge | src/modules/events/lock-events-bridge.ts | lock.* 事件 → Monitor 告警桥（#169 / #64 决议 4） |
| sse-replay-buffer | src/modules/events/sse-replay-buffer.ts | #491：SSE 短窗口内存 replay buffer（环形，按服务端分配的 seq 单调递增）。 |
| workunit-events-bridge | src/modules/events/workunit-events-bridge.ts | WorkUnit 事件 → SSE 桥 |
| applier | src/modules/evolution/applier.ts | E1 约束进化：提案生效器（applier）。 |
| constraint-adapter | src/modules/evolution/constraint-adapter.ts | constraint-adapter（ADR-0033 块 3 子项 7/8）— 约束生命周期提案 adapter |
| evolution.routes | src/modules/evolution/evolution.routes.ts | E1 约束进化 API（vision §6）。 |
| evolution.service | src/modules/evolution/evolution.service.ts | E1 约束进化：服务门面（EvolutionService）。 |
| format-constraint-stats | src/modules/evolution/format-constraint-stats.ts | format-constraint-stats（ADR-0033 块 3 子项 9）— 约束统计白话渲染唯一出口。 |
| generator | src/modules/evolution/generator.ts | E1 约束进化：提案生成器（generator）。 |
| incident-ledger | src/modules/evolution/incident-ledger.ts | E1 约束进化：历史事故台账（incident ledger，#602 D5 bootstrap）。 |
| review-adapter | src/modules/evolution/review-adapter.ts | review-adapter (#623) — evolution 人审提案 adapter（接线 review-proposal 正本） |
| signals | src/modules/evolution/signals.ts | E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：路径解析 + 信号加载。 |
| routes | src/modules/executions/routes.ts | Execution API 路由 |
| agents.routes | src/modules/harness/agents.routes.ts | agents.routes — Harness Agent 生命周期子路由（T-014） |
| constraints.routes | src/modules/harness/constraints.routes.ts | constraints.routes — Harness 约束清单与质量门子路由（T-002 / M2） |
| cso.routes | src/modules/harness/cso.routes.ts | cso.routes — CSO 验证子路由（Decision #5） |
| dashboard.routes | src/modules/harness/dashboard.routes.ts | dashboard.routes — Harness 健康检查子路由（T-017） |
| diagnostics.routes | src/modules/harness/diagnostics.routes.ts | diagnostics.routes — Harness 错误分类子路由（T-016） |
| knowledge.routes | src/modules/harness/knowledge.routes.ts | knowledge.routes — Harness 知识引擎子路由（T-010） |
| routes | src/modules/harness/routes.ts | FL-029: Harness Monitoring Routes (T-015)（挂载门面） |
| runtime | src/modules/harness/runtime.ts | runtime.ts — Harness 路由共享运行时 |
| sanitize-context | src/modules/harness/sanitize-context.ts | 证据标志剥离（#641 信任边界）：被检查者不能自证。 |
| sessions.routes | src/modules/harness/sessions.routes.ts | sessions.routes — Harness 上下文管理子路由（T-011） |
| traces.routes | src/modules/harness/traces.routes.ts | traces.routes — Harness 执行轨迹采集/分析子路由（T-015） |
| conversation-extractor | src/modules/knowledge/conversation-extractor.ts | conversation-extractor — R3 会话提取管道。 |
| entries.routes | src/modules/knowledge/entries.routes.ts | entries.routes — 知识条目子路由（KnowledgeStore 条目的导出/问答/缺口/统一浏览） |
| files.routes | src/modules/knowledge/files.routes.ts | files.routes — 知识库文件浏览子路由（文件系统扫描/读取） |
| internal.routes | src/modules/knowledge/internal.routes.ts | internal.routes — 知识库内部子路由（无 auth，本地服务间调用） |
| knowledge-data-layer | src/modules/knowledge/knowledge-data-layer.ts | knowledge-data-layer — KnowledgeService 的数据层（文件系统存取） |
| knowledge-design-doc | src/modules/knowledge/knowledge-design-doc.ts | knowledge-design-doc — 设计时知识沉淀工具（#343 起自 knowledge-bus.service.ts 迁出） |
| knowledge-form-gate | src/modules/knowledge/knowledge-form-gate.ts | knowledge-form-gate — 知识形态门禁（knowledge / data / skill / rule 判定）。 |
| knowledge-forms | src/modules/knowledge/knowledge-forms.ts | knowledge-forms — 知识形态门禁（form validation gate） |
| knowledge-metrics | src/modules/knowledge/knowledge-metrics.ts | knowledge-metrics — KnowledgeService 的 Measure 能力带（飞轮度量 / 健康 / 审计 / 准确度）。 |
| knowledge-search-helpers | src/modules/knowledge/knowledge-search-helpers.ts | knowledge-search-helpers — 关键词检索与 RAG 降级 helpers |
| knowledge-semantic-search | src/modules/knowledge/knowledge-semantic-search.ts | knowledge-semantic-search — mcp-local-rag 语义检索支撑。 |
| knowledge-store-memo | src/modules/knowledge/knowledge-store-memo.ts | MtimeMemoKnowledgeStore — FileKnowledgeStore 的 mtime 校验聚合 memo 包装（#343）。 |
| knowledge-types | src/modules/knowledge/knowledge-types.ts | knowledge-types — KnowledgeService 的 Studio 侧类型与类型映射 |
| maintenance.routes | src/modules/knowledge/maintenance.routes.ts | Knowledge Maintenance Routes — F1 知识库维护的手动触发入口 |
| pattern-entry | src/modules/knowledge/pattern-entry.ts | pattern-entry — 交互模式（type='pattern'）条目的查询与正文解析统一口径 |
| review-adapter | src/modules/knowledge/review-adapter.ts | review-adapter (#355) — knowledge 提案审批 adapter（接线 review-proposal 正本） |
| routes | src/modules/knowledge/routes.ts | 知识库 API - 公司数字资产管理（挂载门面） |
| search.routes | src/modules/knowledge/search.routes.ts | search.routes — 知识检索与解法指标子路由 |
| trend-data | src/modules/knowledge/trend-data.ts | trend-data — 趋势数据层（~/.studio/data/trends/ 目录写入）。 |
| routes | src/modules/lark/routes.ts | 飞书机器人交互回调 |
| channel.tools | src/modules/mcp/channel.tools.ts | MCP Tools — Channel 消息（P2，#566） |
| devops.tools | src/modules/mcp/devops.tools.ts | MCP Tools — DevOps 发布 |
| economy.tools | src/modules/mcp/economy.tools.ts | MCP Tools — 经济系统 |
| pmo.tools | src/modules/mcp/pmo.tools.ts | MCP Tools — PMO 项目管理 |
| requirement.tools | src/modules/mcp/requirement.tools.ts | MCP Tools — Requirement 需求（P2，#566） |
| routes | src/modules/mcp/routes.ts | MCP HTTP Routes |
| safety.tools | src/modules/mcp/safety.tools.ts | MCP Tools — 安全约束 |
| server | src/modules/mcp/server.ts | MCP Server - Model Context Protocol 服务器 |
| skill.tools | src/modules/mcp/skill.tools.ts | MCP Tools — Skill 按需加载 |
| spec.tools | src/modules/mcp/spec.tools.ts | MCP Tools — 规格审查（FileStore） |
| system.tools | src/modules/mcp/system.tools.ts | MCP Tools — Agent-First 系统健康与事件 |
| task.tools | src/modules/mcp/task.tools.ts | MCP Tools — 任务管理（FileStore） |
| tool-store | src/modules/mcp/tool-store.ts | MCP Tools 共享 FileStore 存取助手 |
| workunit.tools | src/modules/mcp/workunit.tools.ts | MCP Tools — WorkUnit |
| current-wu-context | src/modules/monitoring/current-wu-context.ts | 当前 WU 聚合上下文（2026-07 PMO-flow UX §6-1；#318 自 monitoring.service 提取为共享出口）： |
| metrics-aggregate | src/modules/monitoring/metrics-aggregate.ts | D16 聚合核心纯函数（工单 30 自 metrics.service.ts 纯函数区抽出，纯搬运零逻辑变更）： |
| metrics.service | src/modules/monitoring/metrics.service.ts | D16 监控指标聚合（B5）— 任务流健康 / 入口转化 / 人工干预 / 周期 / 角色 / 工程质量 / Token / 告警。 |
| metrics.types | src/modules/monitoring/metrics.types.ts | D16 监控指标类型契约（工单 30 自 metrics.service.ts 类型区抽出，纯搬运零逻辑变更）： |
| routes | src/modules/notifications/routes.ts | 通知 API 路由 |
| clawbot-client | src/modules/notify-channels/clawbot-client.ts | #525 P2-6：ClawBot（iLink 协议）客户端 —— 扫码绑定 + 文本发送 |
| config-store | src/modules/notify-channels/config-store.ts | #525 P2-6：/settings「通知渠道」配置存储 —— ~/.studio 数据区配置文件读写 |
| routes | src/modules/notify-channels/routes.ts | #525 P2-6：/api/v1/notify-channels —— /settings「通知渠道」配置区读写 API |
| wecom-client | src/modules/notify-channels/wecom-client.ts | 企业微信群机器人 markdown 发送唯一出口（#525 review 收口）： |
| routes | src/modules/outbound-notify/routes.ts | Notify API 路由 |
| analysis-handoff | src/modules/pmo/analysis-handoff.ts | Analysis Handoff — PMO 规划/分析接力（规划结论 → 拆任务 → 派工） |
| decision-resolution | src/modules/pmo/decision-resolution.ts | Decision Resolution — 决策落地（#110，#106 子票 T4） |
| delivery-notify | src/modules/pmo/delivery-notify.ts | #469：PMO 项目里程碑出声统一出口（completed/in_review 翻转 + 交付播报）。 |
| delivery | src/modules/pmo/delivery.ts | PMO-b（2026-07-28 分析文档 §4.5，决策 1）：交付守卫与台账。 |
| evidence-summary | src/modules/pmo/evidence-summary.ts | PMO 证据台账共享口径（2026-07-30 抽取）：delivery.ts 台账与 progress-rollup.ts |
| keyed-enqueue | src/modules/pmo/keyed-enqueue.ts | 按 key 的 Promise 链式串行化——pmo/ 内 map 写五处同构拷贝的收口 |
| map-opening | src/modules/pmo/map-opening.ts | Map Opening — 开图机制（#112，#106 子票 T6；#471 起降级为台账记录） |
| plan-direction | src/modules/pmo/plan-direction.ts | Plan Direction — 方向锁定（#567）：plan 一脉会话裁决轮前置的一次性方向人闸。 |
| plan-ruling | src/modules/pmo/plan-ruling.ts | Plan Ruling — 裁决轮（#467）：plan 一脉会话内的一次性人闸。 |
| progress-rollup | src/modules/pmo/progress-rollup.ts | B3a 工程归属链（决策 D2）：PMO 项目进度回写。 |
| routes | src/modules/pmo/routes.ts | 收集请求里的 gitRepo/gitRepos 候选（仅非空字符串；空串视为未传，与既有口径一致） |
| spec-materialization | src/modules/pmo/spec-materialization.ts | Spec Materialization — 交稿物化（#115 T9，#106 验收标准 4） |
| project-discovery.service | src/modules/projects/project-discovery.service.ts | AC-D1+D3: Project Discovery Service |
| project-exclude-config | src/modules/projects/project-exclude-config.ts | #266（决策 #258）：归属问答候选集排除清单 —— ~/.studio 数据区配置文件读写 |
| project.routes | src/modules/projects/project.routes.ts | AC-D3: Project Discovery API |
| channel-req-pmo | src/modules/requirements/channel-req-pmo.ts | 频道 REQ 挂接 PMO 查询原语（#636 自 channels/file-ref-vocabulary 下沉）： |
| ownership-resolver | src/modules/requirements/ownership-resolver.ts | B3a 工程归属链（决策 D2）— WorkUnit 创建时的工程归属解析。 |
| pmo-branch-resolver | src/modules/requirements/pmo-branch-resolver.ts | PMO-b（2026-07-28 分析文档 §4.5，决策 3）：WU → PMO 分支解析。 |
| req-binding | src/modules/requirements/req-binding.ts | REQ 绑定解析（vision §5.3）— @mention 派发 / convert-to-task 共用。 |
| requirement.routes | src/modules/requirements/requirement.routes.ts | Requirement API 路由 — REQ 需求编号体系（vision §5.3） |
| requirement.service | src/modules/requirements/requirement.service.ts | Requirement Service — REQ 需求编号体系（vision §5.3） |
| rollup | src/modules/requirements/rollup.ts | REQ 状态汇总（vision §5.3）：订阅 workunit.status_changed， |
| wu-pmo-attribution | src/modules/requirements/wu-pmo-attribution.ts | WU → PMO 创建期归因戳（2026-08 归因统一）：canonical metadata key = `pmoId`。 |
| card | src/modules/review-proposal/card.ts | review-proposal/card (#351) — 人审提案卡投放 #系统 频道（唯一正本） |
| registry | src/modules/review-proposal/registry.ts | review-proposal/registry (#351) — 人审提案卡 adapter 注册表（kind → adapter） |
| routes | src/modules/review-proposal/routes.ts | review-proposal/routes (#351) — 人审提案卡通用端点（ADR 决策 4） |
| service | src/modules/review-proposal/service.ts | review-proposal/service (#351) — 人审提案卡生命周期（唯一正本） |
| store | src/modules/review-proposal/store.ts | review-proposal/store (#351) — 人审提案卡通用存取（append-only JSONL + 状态墓碑折叠） |
| completion-extraction | src/modules/role-memory/completion-extraction.ts | completion-extraction (#99) — WU 收尾批量提取钩子 |
| review-adapter | src/modules/role-memory/review-adapter.ts | review-adapter (#353) — role-memory 人审提案 adapter（接线 review-proposal 正本） |
| role-memory | src/modules/role-memory/role-memory.ts | role-memory (#98) — 角色记忆存储服务 |
| manifest-generator | src/modules/skills/manifest-generator.ts | manifest-generator |
| review-adapter | src/modules/skills/review-adapter.ts | review-adapter (#354) — skills 提案审批 adapter（接线 review-proposal 正本） |
| routes | src/modules/skills/routes.ts | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| skill-demotion-routes | src/modules/skills/skill-demotion-routes.ts | §10.6 Skill 降级提案 API 路由 |
| skill-demotion | src/modules/skills/skill-demotion.ts | §10.6 skill 生命周期降级通路（聚合 + 降级提案）。 |
| skill-promotion | src/modules/skills/skill-promotion.ts | D11 skill promote 门禁（draft → published）。 |
| skill-usage-scan | src/modules/skills/skill-usage-scan.ts | skill-usage-scan — transcript 后验使用扫描（skill 度量地基票 B，usage 主口径）。 |
| routes | src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| transcript-archive | src/modules/transcripts/transcript-archive.ts | transcript-archive — transcript 归档器（#97，#88 子票） |
| transcript.routes | src/modules/transcripts/transcript.routes.ts | Transcript 只读路由（#174，#60 C5） |
| inspection-scan | src/modules/triggers/inspection-scan.ts | #163（T8-E2，#130 决策 4/5）：inspection-scan 触发器的事件闸——bug 关闭累计计数 + 冷却去重。 |
| trigger-assignee-check | src/modules/triggers/trigger-assignee-check.ts | 检查 CREATE 类 trigger 的 assigneeRole 是否解析到「存在且 loop running」的角色。 |
| workspace-store | src/modules/workspaces/workspace-store.ts | Workspace Store — F6: 共享的 workspace 记录读取 |
| assignee-resolver | src/modules/workunit/assignee-resolver.ts | assigneeId 双语义批量解析器（语义权威：apps/api/src/modules/workunit/CONTEXT.md「assigneeId 双语义」条）。 |
| blocked-cta | src/modules/workunit/blocked-cta.ts | #176（决策 #57 D3）：blocked 相关消息的统一行动召唤（CTA）模板 —— 按钮缺位期的正式交互替代。 |
| claim-announce | src/modules/workunit/claim-announce.ts | #445（spec #441 情境引导 04）：「认领即发声」原语 —— 自 agent-loop 私有方法 |
| confirm-payload | src/modules/workunit/confirm-payload.ts | #463：review-passed 结构化 confirm body 的校验与序列化（唯一正本）。 |
| delegation-gate | src/modules/workunit/delegation-gate.ts | DelegationGate — A2A 协作委派闸门（2026-07-agent-to-agent-collab-design §4.1 机制 3 / §4.2） |
| gate-escalation | src/modules/workunit/gate-escalation.ts | #523 P0-3 人闸催办与认领滞留（#516 决议③④，2026-09-12 定案）。 |
| http-helpers | src/modules/workunit/http-helpers.ts | #551：workunit 路由层 HTTP 助手——错误契约收口唯一正本。 |
| in-review-inbox | src/modules/workunit/in-review-inbox.ts | #464：无频道 in_review 统一进 Web「需要处理」收件箱。 |
| inspection-opportunities | src/modules/workunit/inspection-opportunities.ts | #163（T8-E2，#130 决策 2/6）：巡检机会清单的采纳/忽略——机制消费入口。 |
| merge-on-review-pass | src/modules/workunit/merge-on-review-pass.ts | B3b-ii 评审通过后自动合并（决策 D1/D3 后半） |
| timeout-release | src/modules/workunit/timeout-release.ts | P0 修复（WU 超时机制）：workunit-timeout 触发器的 EXECUTE handler。 |
| waiting-input | src/modules/workunit/waiting-input.ts | F5 双向沟通：blocked WorkUnit 的恢复与超时提醒。 |
| workunit-crud | src/modules/workunit/workunit-crud.ts | WorkUnit CRUD + Claim 持久化层 —— WorkUnitService 的基类（自 workunit.service.ts 拆分，纯代码移动）。 |
| workunit.mappers | src/modules/workunit/workunit.mappers.ts | WorkUnit 快照 ↔ DTO 转换层（工单 30 自 workunit.service.ts 抽出，纯搬运零逻辑变更）。 |
| workunit.types | src/modules/workunit/workunit.types.ts | WorkUnit 类型契约 + 状态机表/超时常量（工单 30 自 workunit.service.ts 头部抽出，纯搬运零逻辑变更）。 |
| wu-changed-files | src/modules/workunit/wu-changed-files.ts | #285 AC4（决策 #249 §5）：per-WU 产出/修改文件集的最小查询面 —— |
| wu-dependencies | src/modules/workunit/wu-dependencies.ts | #109（T3，#106 子票）WU 接单依赖（blockedBy）解析与可认领判定。 |
| wu-messenger | src/modules/workunit/wu-messenger.ts | WU 频道系统消息统一出口（wu-messenger）。 |
| wu-metadata | src/modules/workunit/wu-metadata.ts | WU metadata 访问器（2026-08-06 Card 8）：WorkUnitMetadata 的容错解析 / 会话簿记清理 / |
| cloudflared | src/utils/cloudflared.ts | cloudflared — 隧道启停判定（#571 冲突 5 冻结结论：外联隧道默认关） |
| frontend-dist | src/utils/frontend-dist.ts | frontend-dist — 前端产物存在性检查与构建分支（#571 冲突 8 冻结结论） |
| listen-error | src/utils/listen-error.ts | listen-error — server.listen 错误处理（#573 端口双口径收口） |
| listen-host | src/utils/listen-host.ts | 监听地址解析（2026-08-25 安全收口） |
| message-meta | src/utils/message-meta.ts | 消息 meta object×string 双型解析（#264 人审卡片全灭修复定下的口径）。 |
| notifier | src/utils/notifier.ts | 告警通知出口（P0 观测性修复 4）。 |
| runtime-paths | src/utils/runtime-paths.ts | runtime-paths — KNOWLEDGE_DIR / TUNNEL_URL_FILE 归数据根（#571） |
| studio-events-rotation | src/utils/studio-events-rotation.ts | #173（#60 决策 Q3b / spec 批次 C4）：事件保留轮转。 |
| studio-events-tail | src/utils/studio-events-tail.ts | #180（#60 决策 Q3a）：studio-events.jsonl 尾部倒读 + 游标分页。 |
| studio-events | src/utils/studio-events.ts | 薄壳转发（#361）：D18 事件唯一写口实现下沉 @dommaker/studio-shared/src/studio-events.ts。 |
| studio-log-path | src/utils/studio-log-path.ts | 薄壳转发（#361）：实现下沉 @dommaker/studio-shared/src/log-path.ts， |
| studio-log-rotation | src/utils/studio-log-rotation.ts | #213：泛化 jsonl 保留轮转 + 遗留日志一次性归档清理。 |
| token-ledger | src/utils/token-ledger.ts | #320 token 账本（token ledger）— workunit:tokens 事件流的写侧累计派生索引。 |