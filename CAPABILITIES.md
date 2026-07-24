# CAPABILITIES.md

> 最后更新: 2026-07-24

---

| 模块 | 文件 | 说明 |
|------|------|------|
| agent-completer | packages/studio-agent/src/services/agent-completer.ts | Agent Completer - TypeScript 实现的任务完成处理器 |
| agent-executor | packages/studio-agent/src/services/agent-executor.ts | Agent Executor - Session Loop 执行模型 (daemon async spawn) |
| agent-registry | packages/studio-agent/src/services/agent-registry.ts | 注册新 Agent |
| types | packages/studio-agent/src/types.ts | studio-agent 类型定义 |
| export | packages/studio-audit/src/cli/export.ts | Mock 数据 |
| log | packages/studio-audit/src/cli/log.ts | Mock 数据 |
| search | packages/studio-audit/src/cli/search.ts | Mock 数据 |
| audit-chain | packages/studio-audit/src/services/audit-chain.ts | 审计链模块 |
| audit-service | packages/studio-audit/src/services/audit-service.ts | Audit Service - 审计日志服务 (AR-012) |
| types | packages/studio-audit/src/types.ts | types |
| capability.service | packages/studio-capability/src/services/capability.service.ts | Capability Service - 能力管理服务 |
| company-mcp-pool | packages/studio-capability/src/services/company-mcp-pool.ts | 公司 MCP 资源池管理 |
| health-monitor | packages/studio-monitor/src/services/health-monitor.ts | 启动健康监控 |
| list | packages/studio-notification/src/cli/list.ts | Mock 数据 |
| mark | packages/studio-notification/src/cli/mark.ts | Mock 数据 |
| send | packages/studio-notification/src/cli/send.ts | Mock 数据存储 |
| notification-service | packages/studio-notification/src/services/notification-service.ts | 通知服务 |
| types | packages/studio-notification/src/types.ts | types |
| command | packages/studio-shared/src/cli/command.ts | 命令注册框架 |
| config | packages/studio-shared/src/cli/config.ts | 配置加载器 |
| error | packages/studio-shared/src/cli/error.ts | 错误处理 |
| formatter | packages/studio-shared/src/cli/formatter.ts | 输出格式化器 |
| parser | packages/studio-shared/src/cli/parser.ts | 参数解析器 |
| model-tier | packages/studio-shared/src/config/model-tier.ts | Model Tier → 模型名映射（2026-05-08） |
| levels | packages/studio-shared/src/constants/levels.ts | 级别配置 - 全局统一的职级定义 |
| responsibility-chain | packages/studio-shared/src/constants/responsibility-chain.ts | 责任链模型 - 类型定义 |
| stage-definitions | packages/studio-shared/src/constants/stage-definitions.ts | Stage Definitions - 阶段定义 + 关键词 + 推荐函数 |
| event-bus | packages/studio-shared/src/event-bus.ts | Studio Event Bus — 替代 Redis pub/sub（2026-05-08） |
| auditor-types | packages/studio-shared/src/harness/auditor/auditor-types.ts | Auditor ↔ 其他角色协议定义（BP-013 + BP-014） |
| agent.hooks | packages/studio-shared/src/harness/hooks/agent.hooks.ts | Agent Execution Phase Hooks |
| audit | packages/studio-shared/src/harness/hooks/audit.ts | Audit Recorder — 决策级审计事件记录 |
| completion.hooks | packages/studio-shared/src/harness/hooks/completion.hooks.ts | Completion & Review Phase Hooks |
| config | packages/studio-shared/src/harness/hooks/config.ts | Per-Hook Runtime Config（S10 修复） |
| goal.hooks | packages/studio-shared/src/harness/hooks/goal.hooks.ts | Goal Phase Hooks |
| pr.hooks | packages/studio-shared/src/harness/hooks/pr.hooks.ts | PR Creation Phase Hooks |
| register | packages/studio-shared/src/harness/hooks/register.ts | Hook 注册 — Phase 2 迁移 |
| prompt-injection | packages/studio-shared/src/harness/prompt-injection.ts | Constraint Prompt Injection — 将 harness 约束的前置声明注入 Agent prompt |
| bootstrap | packages/studio-shared/src/harness/runtime/bootstrap.ts | Harness Runtime Bootstrap — Phase 2 迁移 |
| cache | packages/studio-shared/src/harness/runtime/cache.ts | Constraint Check Cache（S7 修复） |
| session-metrics | packages/studio-shared/src/harness/session-metrics.ts | Session Metrics — parse claude --output-format json output into structured metrics. |
| llm-client | packages/studio-shared/src/llm/llm-client.ts | LLM 客户端 |
| system-executor | apps/api/src/modules/agents/system-executor.ts | SystemExecutor — 系统级 LLM 调用抽象，替代 modelGateway |
| memory-store | packages/studio-shared/src/memory-store.ts | MemoryStore — 内存替代 Redis (B0-011) |
| node | packages/studio-shared/src/node.ts | Node.js 专用入口 — 包含 CLI 和 Config 模块 |
| goal-status | packages/studio-shared/src/types/goal-status.ts | Goal 状态类型 — SQLite 不支持 enum，用 TypeScript 类型守卫约束 |
| resolution | packages/studio-shared/src/types/resolution.ts | Resolution types — RKB (Resolution Knowledge Base) |
| stance | packages/studio-shared/src/types/stance.ts | 立场系统类型定义 |
| event-emitter | packages/studio-shared/src/utils/event-emitter.ts | 事件系统 |
| logger | packages/studio-shared/src/utils/logger.ts | Shared Logger - 统一日志接口 |
| parallel-executor | packages/studio-shared/src/utils/parallel-executor.ts | 并行执行器 |
| process-io | packages/studio-shared/src/utils/process-io.ts | Process I/O utilities — spawn, session-id persistence, file bridge |
| scheduler | packages/studio-shared/src/utils/scheduler.ts | 资源感知调度器 |
| spec-parser | packages/studio-shared/src/utils/spec-parser.ts | Spec Markdown 解析器 |
| loader | packages/studio-skill/src/loader.ts | SkillLoader — 按 trigger 加载 Skill，注入 Agent prompt |
| types | packages/studio-skill/src/types.ts | Skill 定义类型 |
| acceptance-validator | packages/studio-spec/src/services/acceptance-validator.ts | 验收层验证器 |
| api-validator | packages/studio-spec/src/services/api-validator.ts | API 层验证器 |
| architecture-validator | packages/studio-spec/src/services/architecture-validator.ts | 架构层验证器 |
| change-analyzer.service.test | packages/studio-spec/src/services/change-analyzer.service.test.ts | ChangeAnalyzerService 单元测试 |
| change-analyzer.service | packages/studio-spec/src/services/change-analyzer.service.ts | 变更分析服务 |
| change-history.service.test | packages/studio-spec/src/services/change-history.service.test.ts | ChangeHistoryService 单元测试 |
| change-history.service | packages/studio-spec/src/services/change-history.service.ts | 变更历史服务 |
| gate-checker.service.test | packages/studio-spec/src/services/gate-checker.service.test.ts | GateCheckerService 单元测试 |
| gate-checker.service | packages/studio-spec/src/services/gate-checker.service.ts | 门禁检查服务 |
| spec-validator.service.test | packages/studio-spec/src/services/spec-validator.service.test.ts | SpecValidator 单元测试 |
| spec-validator.service | packages/studio-spec/src/services/spec-validator.service.ts | SpecValidator 主服务 |
| change.types | packages/studio-spec/src/types/change.types.ts | Spec 变更分级类型定义 |
| gate.types | packages/studio-spec/src/types/gate.types.ts | 门禁类型定义 |
| validation.types | packages/studio-spec/src/types/validation.types.ts | Spec 验证类型定义 |
| clean | packages/studio-task/src/cli/clean.ts | clean |
| queue | packages/studio-task/src/cli/queue.ts | queue |
| retry | packages/studio-task/src/cli/retry.ts | retry |
| run | packages/studio-task/src/cli/run.ts | run |
| task-queue | packages/studio-task/src/services/task-queue.ts | TaskQueue - 任务队列管理器 |
| task-worker | packages/studio-task/src/services/task-worker.ts | TaskWorker - 任务队列消费者 |
| types | packages/studio-task/src/types.ts | CLI 命令选项和输出类型 |
| docs-freshness.routes | apps/api/src/modules/admin/docs-freshness.routes.ts | T-020 + T-059: CLAUDE.md + CAPABILITIES.md Freshness Check |
| routes | apps/api/src/modules/agent-configs/routes.ts | agent-configs/routes.ts — Agent Manager + Version Control (HZ-024, HZ-025) |
| auditor-agent.service | apps/api/src/modules/agents/auditor-agent.service.ts | Auditor Agent — 跨任务审计 + 周期洞察 |
| knowledge-agent.service | apps/api/src/modules/agents/knowledge-agent.service.ts | Knowledge Agent - 从执行结果中异步提取知识 |
| monitor-agent.service | apps/api/src/modules/agents/monitor-agent.service.ts | Monitor Agent - 健康监控 + 渐进告警 + G31 知识沉淀闸门(precipitate→TTL) |
| ops-agent.service | apps/api/src/modules/agents/ops-agent.service.ts | Ops Agent — 系统生命周期守护 |
| ops-rules | apps/api/src/modules/agents/ops-rules.ts | Ops Rules — 运行时数据，不在代码里 |
| requirement-gate | apps/api/src/modules/agents/requirement-gate.ts | RequirementGate — RequirementsDoc 质量门 (2026-05-21) |
| review-agent.service | apps/api/src/modules/agents/review-agent.service.ts | Review Agent - 多立场代码审查 + G33 非阻断发现自动曝光 |
| review-report | apps/api/src/modules/agents/review-report.ts | 审查报告类型定义 |
| routes | apps/api/src/modules/agents/routes.ts | Agent API 路由 |
| session-summary-agent.service | apps/api/src/modules/agents/session-summary-agent.service.ts | SessionSummaryAgent — 会话级知识提取 (2026-05-25) |
| triage-agent.service | apps/api/src/modules/agents/triage-agent.service.ts | Triage Agent Service — incident response: diagnose → classify → act → resolve/escalate |
| types | apps/api/src/modules/agents/types.ts | Agent 团队类型定义 |
| audit-subscriber | apps/api/src/modules/audit/audit-subscriber.ts | Audit Event Subscriber — EventBus 审计事件持久化到 DB (B0-002) |
| routes | apps/api/src/modules/audit-logs/routes.ts | GET /api/audit-logs - 查询审计日志 |
| routes | apps/api/src/modules/auth/routes.ts | POST /api/v1/auth/guest-session |
| service | apps/api/src/modules/auth/service.ts | 认证服务 - Auth Service |
| routes | apps/api/src/modules/builtin-tools/routes.ts | builtin-tools/routes.ts — Built-in Toolset (HZ-026) |
| routes | apps/api/src/modules/capabilities/routes.ts | 从 YAML 文件读取 stage 字段 |
| channel-init | apps/api/src/modules/channels/channel-init.ts | Seed default channels on startup (B1-001) |
| channel-message.service | apps/api/src/modules/channels/channel-message.service.ts | ChannelMessage Service — centralized message creation + event publishing |
| channel.routes | apps/api/src/modules/channels/channel.routes.ts | Channel Routes — B1-001/B1-002/B1-009/B1-011 |
| discovery-exposure.service | apps/api/src/modules/channels/discovery-exposure.service.ts | Discovery Exposure Service — G33 Analyst+Reviewer 发现→#系统 channel |
| requirements-doc.routes | apps/api/src/modules/channels/requirements-doc.routes.ts | RequirementsDoc edit routes — B2-009 |
| routes | apps/api/src/modules/dingtalk/routes.ts | 钉钉机器人交互回调 |
| command-runner | apps/api/src/modules/discord/command-runner.ts | B3-002/B3-003: Shared command runner for CLI and Discord |
| routes | apps/api/src/modules/discord/routes.ts | Discord Interactions Endpoint |
| routes | apps/api/src/modules/environments/routes.ts | environments/routes.ts — Environment Manager CRUD (HZ-023) |
| event.routes | apps/api/src/modules/events/event.routes.ts | G30: StudioEvent API Endpoints |
| sse.routes | apps/api/src/modules/events/sse.routes.ts | HZ-028: Event Stream (SSE) |
| routes | apps/api/src/modules/executions/routes.ts | Execution API 路由 |
| iron-laws.routes | apps/api/src/modules/harness/iron-laws.routes.ts | Iron Laws API — 从 runtime-proxy 迁移 (2026-05-14) |
| routes | apps/api/src/modules/harness/routes.ts | FL-029: Harness Monitoring Routes (T-015) |
| decision-chain-extractor | apps/api/src/modules/knowledge/decision-chain-extractor.ts | DecisionChainExtractor (G-004) — 从 Meeting 辩论 + Goal 执行中提取决策链 |
| env-snapper | apps/api/src/modules/knowledge/env-snapper.ts | EnvSnapper (G-003) — 系统环境自动快照 |
| eval-case-generator | apps/api/src/modules/knowledge/eval-case-generator.ts | EvalCaseGenerator — Better-Harness hill-climbing 吸收 |
| evolution-scheduler | apps/api/src/modules/knowledge/evolution-scheduler.ts | Knowledge Evolution Scheduler |
| evolution.service | apps/api/src/modules/knowledge/evolution.service.ts | Knowledge Evolution Engine (§12.12) |
| import.routes | apps/api/src/modules/knowledge/import.routes.ts | Knowledge Import API - 冷启动导入 |
| knowledge-bus.service | apps/api/src/modules/knowledge/knowledge-bus.service.ts | KnowledgeBus — Agent 间共享知识总线 (H1, 2026-05-21) |
| knowledge-query.service | apps/api/src/modules/knowledge/knowledge-query.service.ts | KnowledgeQueryService (S8) — 统一知识检索入口 |
| knowledge-sync.service | apps/api/src/modules/knowledge/knowledge-sync.service.ts | KnowledgeSync — 自运转知识同步系统 |
| pattern-miner | apps/api/src/modules/knowledge/pattern-miner.ts | PatternMiner (G-005) — 从 MCP traces + 审查历史中挖掘交互模式 |
| preference-observer | apps/api/src/modules/knowledge/preference-observer.ts | PreferenceObserver (G-001) — 从 MCP traces + 路由反馈中推断用户偏好 |
| resolution.service | apps/api/src/modules/knowledge/resolution.service.ts | ResolutionService — RKB 匹配/创建/验证 |
| routes | apps/api/src/modules/knowledge/routes.ts | 知识库 API - 公司数字资产管理 |
| rule-scanner | apps/api/src/modules/knowledge/rule-scanner.ts | RuleScanner (G-002) — 从源码/harness 约束/配置中提取业务规则 |
| routes | apps/api/src/modules/lark/routes.ts | 飞书机器人交互回调 |
| config.routes | apps/api/src/modules/llm/config.routes.ts | LLM Config API 路由 |
| config.service | apps/api/src/modules/llm/config.service.ts | LLM Config Service - 加密存储 + 分层配置解析 |
| creation-analyzer | apps/api/src/modules/llm/creation-analyzer.ts | 创建意图分析器 - 从自然语言生成 Skill/Workflow 配置 |
| intent-analyzer | apps/api/src/modules/llm/intent-analyzer.ts | LLM 意图分析器 - 使用 /api/v1/llm/chat（统一使用 Studio LLM 配置） |

| admin.routes | apps/api/src/modules/mcp/admin.routes.ts | MCP Admin Routes — tool management, permissions, audit |
| permission.service | apps/api/src/modules/mcp/permission.service.ts | MCP Permission Service — role×tool access control + audit logging |
| routes | apps/api/src/modules/mcp/routes.ts | MCP HTTP Routes |
| server | apps/api/src/modules/mcp/server.ts | MCP Server - Model Context Protocol 服务器 |
| tool-registry | apps/api/src/modules/mcp/tool-registry.ts | MCP Tool Registry — dynamic registration, health, rate limiting |
| tools | apps/api/src/modules/mcp/tools.ts | MCP Tools 定义 — 含 createWorkUnit (PMO→Channel→Agent) |
| routes | apps/api/src/modules/notifications/routes.ts | 通知 API 路由 |
| notify.service | apps/api/src/modules/outbound-notify/notify.service.ts | NotifyService - 通知服务 |
| routes | apps/api/src/modules/outbound-notify/routes.ts | Notify API 路由 |
| routes | apps/api/src/modules/outputs/routes.ts | 产出文档 API - 存储和展示执行结果 |
| okr.service | apps/api/src/modules/pmo/okr.service.ts | 🆕 AS-016: 获取当前季度 |
| project.service | apps/api/src/modules/pmo/project.service.ts | Project Service - PMO 项目管理 + publish() → Channel + getLinkedSDDs() |
| routes | apps/api/src/modules/pmo/routes.ts | PMO API — 项目 CRUD + POST publish + GET sdd 关联查询 |
| routes | apps/api/src/modules/runtime-config/routes.ts | GET /api/v1/runtime-config |
| routes | apps/api/src/modules/skills/routes.ts | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| routes | apps/api/src/modules/spec-reviews/routes.ts | Spec 审查 API 路由 |
| spec-review.service | apps/api/src/modules/spec-reviews/spec-review.service.ts | Spec 审查服务 |
| routes | apps/api/src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| skill-extraction.service | apps/api/src/modules/skills/skill-extraction.service.ts | Skill Extraction Service — 面向新架构 GoalExecution |
| skill-proposal-routes | apps/api/src/modules/skills/skill-proposal-routes.ts | Skill Proposal API 路由 |
| error-class | apps/api/src/modules/triage/error-class.ts | Triage ErrorClass — B1-007: 八类错误标签 + 严重度三级 + 策略路由 |
| wiki.routes | apps/api/src/modules/wiki/wiki.routes.ts | GET /api/v1/wiki |
| channel | apps/web/src/api/channel.ts | Channel API — list + publish 发布 |
| useCapabilities | apps/web/src/hooks/useCapabilities.ts | 获取 Stage 分类数据（UI-001） |
| useChannelEvents | apps/web/src/hooks/useChannelEvents.ts | Channel SSE hook — B2: EventSource 实时推送替代 3s 轮询 |
| useCompanyId | apps/web/src/hooks/useCompanyId.ts | useCompanyId - 统一获取公司 ID |

| useGlobalModals | apps/web/src/hooks/useGlobalModals.ts | 全局弹窗状态 hook |
| useWebSocket | apps/web/src/hooks/useWebSocket.ts | WebSocket 连接管理 Hook（P2-4） |
| useWebSocketHandlers | apps/web/src/hooks/useWebSocketHandlers.ts | WebSocket 事件处理 hook |
| agentStore | apps/web/src/stores/agentStore.ts | agentStore |
| authStore | apps/web/src/stores/authStore.ts | 认证状态管理 - Auth Store (Zustand) |
| runtimeStore | apps/web/src/stores/runtimeStore.ts | runtimeStore |
| uiStore | apps/web/src/stores/uiStore.ts | uiStore |
| setup | apps/web/src/test/setup.ts | setup |
| canvas | apps/web/src/types/canvas.ts | 共享画布类型（xyflow 兼容，避免直接导入 xyflow 打包） |
| types | apps/web/src/types.ts | types.ts - Agent Studio 类型定义 |
| api | apps/web/src/utils/api.ts | 获取 API 基础 URL |
| format | apps/web/src/utils/format.ts | 格式化 Token 数量 |
| toast | apps/web/src/utils/toast.ts | Lightweight toast notification system (zero dependencies) |

| session-summary-generator | apps/api/src/modules/events/session-summary-generator.ts | B9-015: SessionSummaryGenerator — server-side session aggregation |
| output-capture | packages/studio-agent/src/services/output-capture.ts | Output Capture — 进度读取 + 输出文件收集 + session 指标记录 |
| session-manager | packages/studio-agent/src/services/session-manager.ts | Session Manager — Agent 执行器核心（session loop + async spawn） |
| worktree-resolver | packages/studio-agent/src/services/worktree-resolver.ts | Worktree Resolver — git worktree 创建 + harness 配置传播 + 文件桥 |
| user-behavior | packages/studio-shared/src/types/user-behavior.ts | User Behavior Profile types — KE-003 |
| skill-loader | apps/api/src/modules/skills/skill-loader.ts | SkillLoader API Service — DB-driven skill loading with session lifecycle |

| daemon-routes | apps/api/src/modules/workspaces/daemon-routes.ts | Daemon Routes — AS-020 P5: HTTP Claim + Event Reporting |
| gc-service | apps/api/src/modules/workspaces/gc-service.ts | GC Service — AS-020 P5: Garbage collection for old tasks and events |
| local-workspace | apps/api/src/modules/workspaces/local-workspace.ts | Local Workspace Registration — AS-020 P2-04 |
| task-routes | apps/api/src/modules/workspaces/task-routes.ts | Task Routes — AS-020 P5: UI/Server task management |
| token.routes | apps/api/src/modules/workspaces/token.routes.ts | Workspace Token Routes — AS-020 P2-05: Token management (admin) |
| workspace.routes | apps/api/src/modules/workspaces/workspace.routes.ts | Workspace Routes — AS-020 P2: Workspace registration + heartbeat + token management |
| ws-gateway | apps/api/src/modules/workspaces/ws-gateway.ts | WebSocket Gateway — AS-020 P4: Daemon persistent connection |
| agent-runner | packages/studio-agent/src/services/agent-runner.ts | Agent Runner — unified executor merging AgentExecutor + TaskExecutor |

| stream-json-parser | packages/studio-shared/src/llm/stream-json-parser.ts | Stream-JSON Parser — 解析 Claude CLI --output-format stream-json 输出 |
| failure-classifier | apps/api/src/modules/shared/failure-classifier.ts | Failure classifier — pattern matching on error messages |
| prompt-builder | apps/api/src/modules/knowledge/consumers/prompt-builder.ts | Unified knowledge injection entry point. |
| unified-query | apps/api/src/modules/knowledge/engine/unified-query.ts | UnifiedQuery — dual-store unified query layer. |
| knowledge-service.routes | apps/api/src/modules/knowledge/knowledge-service.routes.ts | KnowledgeService HTTP API + SSE |
| knowledge-service | apps/api/src/modules/knowledge/knowledge-service.ts | KnowledgeService — Unified knowledge capability layer |
| signal-aggregator | apps/api/src/modules/knowledge/signal-aggregator.ts | Signal Aggregator — 原始 signal 条目 → 趋势聚合摘要（≥3次/7天） |
| external-fetcher | apps/api/src/modules/knowledge/producers/external-fetcher.ts | ExternalFetcher — fetch external docs and ingest as reference knowledge. |
| concurrency-control | packages/studio-shared/src/utils/concurrency-control.ts | Concurrency control utilities extracted from Pipeline scheduler. |
| error-file-extractor | packages/studio-shared/src/utils/error-file-extractor.ts | Extract affected file paths from compiler/test error messages. |
| git-utils | packages/studio-shared/src/utils/git-utils.ts | Git utility functions extracted from Pipeline executor-subagent-spawner. |
| sdd-utils | packages/studio-shared/src/utils/sdd-utils.ts | SDD 工具函数 — frontmatter 解析 + slug 生成 |
| intent-router | packages/studio-skill/src/intent-router.ts | Match task text against skill name/description. |
| agent-instance.routes | apps/api/src/modules/agents/agent-instance.routes.ts | RuntimeInstance API 路由 (AS-026 AC-1) |
| agent-instance.service | apps/api/src/modules/agents/agent-instance.service.ts | AgentInstance Service — RuntimeInstance CRUD |
| agent-loop | apps/api/src/modules/agents/agent-loop.ts | Analyze agent log for knowledge search behavior. |
| agent-profile.routes | apps/api/src/modules/agents/agent-profile.routes.ts | AgentProfile API 路由 (AS-025 Phase 2) |
| agent-profile.service | apps/api/src/modules/agents/agent-profile.service.ts | AgentProfile Service — 简化 Agent 身份 CRUD |
| default-triggers | apps/api/src/modules/agents/default-triggers.ts | Default Triggers — 6 system triggers for Agent Network |
| eval-case-store | apps/api/src/modules/knowledge/eval-case-store.ts | EvalCaseStore — File-based CRUD for eval cases |
| monitoring.routes | apps/api/src/modules/monitoring/monitoring.routes.ts | Monitoring Routes — Agent Network (MVP-2 + MVP-6) |
| monitoring.service | apps/api/src/modules/monitoring/monitoring.service.ts | Monitoring Service — Agent Network aggregation (MVP-2 + MVP-6) |
| sdd-freshness.service | apps/api/src/modules/sdd/sdd-freshness.service.ts | SDD Doc Freshness Service |
| manifest-loader | apps/api/src/modules/skills/manifest-loader.ts | manifest-loader (AS-025 3.28c-5) |
| proposal-store | apps/api/src/modules/skills/proposal-store.ts | ProposalStore — File-based CRUD for SkillProposal |
| skill-selector | apps/api/src/modules/skills/skill-selector.ts | skill-selector (AS-025 3.28c-5) |
| skill-store | apps/api/src/modules/skills/skill-store.ts | SkillStore — File-based CRUD for Skill metadata |
| cron-matcher | apps/api/src/modules/triggers/cron-matcher.ts | Cron Matcher — minimal cron expression evaluator (3.28c-4) |
| trigger-action | apps/api/src/modules/triggers/trigger-action.ts | Execute a CREATE action — creates a WorkUnit from trigger payload. |
| trigger-registry | apps/api/src/modules/triggers/trigger-registry.ts | Trigger Registry — singleton TriggerScheduler with eventBus injection |
| trigger-scheduler | apps/api/src/modules/triggers/trigger-scheduler.ts | TriggerScheduler — SCHEDULE tick + EVENT EventBus subscription |
| trigger-store | apps/api/src/modules/triggers/trigger-store.ts | Trigger Store — YAML-based trigger config persistence (3.28c-4) |
| trigger.routes | apps/api/src/modules/triggers/trigger.routes.ts | Trigger Routes — REST API for trigger management (3.28c-4) |
| trigger.types | apps/api/src/modules/triggers/trigger.types.ts | Trigger Types — SCHEDULE + EVENT discriminated union (AS-026) |
| wiki.service | apps/api/src/modules/wiki/wiki.service.ts | Wiki service — SDD-based read logic |
| workunit.routes | apps/api/src/modules/workunit/workunit.routes.ts | WorkUnit API 路由 (AS-025 §3.28c-1, §5.16) |
| workunit.service | apps/api/src/modules/workunit/workunit.service.ts | WorkUnit Service — CRUD + Claim + 状态机 + create() 发布 workunit.created 事件 |
| monitoring | apps/web/src/api/monitoring.ts | Monitoring API — Agent Network (MVP-2 + MVP-6) |
| workunit | apps/web/src/api/workunit.ts | WorkUnit API — Agent Network §3.28c-1 |
| workunitStore | apps/web/src/stores/workunitStore.ts | WorkUnit Store — Agent Network §3.28c-1 |
| cli-adapter | packages/studio-agent/src/cli-adapter.ts | CLI Adapter — translate common spawn params to provider-specific args |
| registry | packages/studio-agent/src/registry.ts | Agent Persona 注册表 |
| file-store | packages/studio-shared/src/file-store.ts | FileStore — AN 运行时数据文件存储基类 |
| anomaly-detector | packages/studio-shared/src/stats/anomaly-detector.ts | 计算数组的均值和标准差（总体标准差） |
| system-health | apps/api/src/modules/agents/system-health.ts | 系统健康采集模块（纯代码，零 LLM） |
| convert-to-task.service | apps/api/src/modules/channels/convert-to-task.service.ts | AC-E2: Convert to Task Service |
| message-routing | apps/api/src/modules/channels/message-routing.ts | Message routing logic for channel messages (AC-B1-B4). |
| okr-anomaly-detector | apps/api/src/modules/pmo/okr-anomaly-detector.ts | okr-anomaly-detector |
| project-discovery.service | apps/api/src/modules/projects/project-discovery.service.ts | AC-D1+D3: Project Discovery Service |
| project.routes | apps/api/src/modules/projects/project.routes.ts | AC-D3: Project Discovery API |
| providers | packages/studio-shared/src/providers.ts | Provider Registry — single source of truth for agent CLI providers (F4) |
| events-dir | packages/studio-shared/src/utils/events-dir.ts | R2 事件目录统一（断点 D，docs/plans/2026-07-flywheel-repair.md）。 |
| agent-loop-registry | apps/api/src/modules/agents/agent-loop-registry.ts | AgentLoopRegistry — profileId → running AgentLoop (F1: AgentLoop 动态挂载) |
| knowledge-singletons | apps/api/src/modules/knowledge/knowledge-singletons.ts | knowledge-singletons — 知识子系统共享单例的唯一所有者 (R4 收敛, 断点 H) |
| req-binding | apps/api/src/modules/requirements/req-binding.ts | REQ 绑定解析（vision §5.3）— @mention 派发 / convert-to-task 共用。 |
| requirement.routes | apps/api/src/modules/requirements/requirement.routes.ts | Requirement API 路由 — REQ 需求编号体系（vision §5.3） |
| requirement.service | apps/api/src/modules/requirements/requirement.service.ts | Requirement Service — REQ 需求编号体系（vision §5.3） |
| rollup | apps/api/src/modules/requirements/rollup.ts | REQ 状态汇总（vision §5.3）：订阅 workunit.status_changed， |
| workspace-store | apps/api/src/modules/workspaces/workspace-store.ts | Workspace Store — F6: 共享的 workspace 记录读取 |
| waiting-input | apps/api/src/modules/workunit/waiting-input.ts | F5 双向沟通：NEED_INPUT 挂起（waiting）WorkUnit 的恢复与超时提醒。 |
| requirements | apps/web/src/api/requirements.ts | Requirement API — REQ 需求编号体系（vision §5.3） |

| prompt-overrides | packages/studio-shared/src/utils/prompt-overrides.ts | E1 约束进化（vision §6）：prompt 模板文件覆盖机制。 |
| applier | apps/api/src/modules/evolution/applier.ts | E1 约束进化：提案生效器（applier）。 |
| channel-review | apps/api/src/modules/evolution/channel-review.ts | E1 约束进化：频道审核（channel review）。 |
| evolution.routes | apps/api/src/modules/evolution/evolution.routes.ts | E1 约束进化 API（vision §6）。 |
| generator | apps/api/src/modules/evolution/generator.ts | E1 约束进化：提案生成器（generator）。 |
| signals | apps/api/src/modules/evolution/signals.ts | E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：路径解析 + 信号加载。 |
| runner-execution | packages/studio-agent/src/services/runner-execution.ts | Runner Execution — session loop 执行（agent-runner.ts 拆分模块） |
| runner-lightweight | packages/studio-agent/src/services/runner-lightweight.ts | Runner Lightweight — 轻量单 session 执行（agent-runner.ts 拆分模块） |
| runner-output | packages/studio-agent/src/services/runner-output.ts | Runner Output — 输出解析（agent-runner.ts 拆分模块） |
| runner-params | packages/studio-agent/src/services/runner-params.ts | Runner Params — 参数构建（agent-runner.ts 拆分模块） |
| auditor-execution | apps/api/src/modules/agents/auditor-execution.ts | Auditor Agent — 建议执行 / 升级 / 闭环 |
| auditor-reports | apps/api/src/modules/agents/auditor-reports.ts | Auditor Agent — 洞察与报告输出 |
| auditor-rules | apps/api/src/modules/agents/auditor-rules.ts | Auditor Agent — 审计规则（检测 → 建议） |
| knowledge-cold-start | apps/api/src/modules/agents/knowledge-cold-start.ts | Knowledge Agent — 冷启动子模块 |
| knowledge-extraction | apps/api/src/modules/agents/knowledge-extraction.ts | Knowledge Agent — 提取 prompt 单一来源 |
| knowledge-maintenance | apps/api/src/modules/agents/knowledge-maintenance.ts | Knowledge Agent — 语料分析（每日维护）子模块 |
| monitor-alerts | apps/api/src/modules/agents/monitor-alerts.ts | Monitor Agent — 告警分发 / Triage 升级 / 事件写入 |
| monitor-lifecycle | apps/api/src/modules/agents/monitor-lifecycle.ts | Monitor Agent — G31 数据生命周期：知识沉淀闸门 + TTL 清理 |
| monitor-probes | apps/api/src/modules/agents/monitor-probes.ts | Monitor Agent — 任务/WorkUnit 级探测 |
| monitor-reports | apps/api/src/modules/agents/monitor-reports.ts | Monitor Agent — 报告：轨迹评估 / 每日洞察 / 交互模式观察 |
| monitor-system-probes | apps/api/src/modules/agents/monitor-system-probes.ts | Monitor Agent — 系统/知识级探测与自修复 |
| agents.routes | apps/api/src/modules/harness/agents.routes.ts | agents.routes — Harness Agent 生命周期子路由（T-014） |
| constraints.routes | apps/api/src/modules/harness/constraints.routes.ts | constraints.routes — Harness 约束生命周期与质量门子路由（T-002 / M2） |
| cso.routes | apps/api/src/modules/harness/cso.routes.ts | cso.routes — CSO 验证子路由（Decision #5） |
| dashboard.routes | apps/api/src/modules/harness/dashboard.routes.ts | dashboard.routes — Harness 仪表盘与健康检查子路由（T-017） |
| diagnostics.routes | apps/api/src/modules/harness/diagnostics.routes.ts | diagnostics.routes — Harness 错误分类/规格检查/验证循环子路由（T-016 / T-018 / T-013） |
| guards.routes | apps/api/src/modules/harness/guards.routes.ts | guards.routes — Harness 安全护栏子路由（T-012） |
| knowledge.routes | apps/api/src/modules/harness/knowledge.routes.ts | knowledge.routes — Harness 知识引擎子路由（T-010） |
| proposals.routes | apps/api/src/modules/harness/proposals.routes.ts | proposals.routes — Harness 约束进化与提案子路由（T-002） |
| runtime | apps/api/src/modules/harness/runtime.ts | runtime.ts — Harness 路由共享运行时 |
| sessions.routes | apps/api/src/modules/harness/sessions.routes.ts | sessions.routes — Harness 上下文管理子路由（T-011） |
| traces.routes | apps/api/src/modules/harness/traces.routes.ts | traces.routes — Harness 执行轨迹采集/分析/诊断子路由（T-015） |
| document-store | apps/api/src/modules/knowledge/document-store.ts | document-store — 文档 FileStore 存取助手 |
| documents.routes | apps/api/src/modules/knowledge/documents.routes.ts | documents.routes — 知识库文档子路由（公司数字资产管理） |
| entries.routes | apps/api/src/modules/knowledge/entries.routes.ts | entries.routes — 知识条目子路由（KnowledgeStore 条目的导出/问答/缺口/统一浏览） |
| files.routes | apps/api/src/modules/knowledge/files.routes.ts | files.routes — 知识库文件浏览子路由（文件系统扫描/读取） |
| internal.routes | apps/api/src/modules/knowledge/internal.routes.ts | internal.routes — 知识库内部子路由（无 auth，本地服务间调用） |
| search.routes | apps/api/src/modules/knowledge/search.routes.ts | search.routes — 知识检索与解法指标子路由 |
| devops.tools | apps/api/src/modules/mcp/devops.tools.ts | MCP Tools — DevOps 发布 |
| economy.tools | apps/api/src/modules/mcp/economy.tools.ts | MCP Tools — 经济系统 |
| knowledge.tools | apps/api/src/modules/mcp/knowledge.tools.ts | MCP Tools — 知识库（FileStore） |
| pmo.tools | apps/api/src/modules/mcp/pmo.tools.ts | MCP Tools — PMO 项目管理 |
| safety.tools | apps/api/src/modules/mcp/safety.tools.ts | MCP Tools — 安全约束 |
| skill.tools | apps/api/src/modules/mcp/skill.tools.ts | MCP Tools — Skill 按需加载 |
| spec.tools | apps/api/src/modules/mcp/spec.tools.ts | MCP Tools — 规格审查（FileStore） |
| system.tools | apps/api/src/modules/mcp/system.tools.ts | MCP Tools — Agent-First 系统健康与事件 |
| task.tools | apps/api/src/modules/mcp/task.tools.ts | MCP Tools — 任务管理（FileStore） |
| tool-store | apps/api/src/modules/mcp/tool-store.ts | MCP Tools 共享 FileStore 存取助手 |
| workunit.tools | apps/api/src/modules/mcp/workunit.tools.ts | MCP Tools — WorkUnit |
| mock-data | apps/web/src/pages/design-lab/mock-data.ts | Design Lab — 视觉方向稿共用 mock 数据（T1 方向稿专用，不接任何真实 API） |
| useChannelList | apps/web/src/hooks/useChannelList.ts | 频道列表数据 hook —— ChannelListPage 与 Mission Control 左栏 ChannelRail 共用 |
| knowledge | apps/web/src/api/knowledge.ts | Knowledge Service API — 2026-07 知识审核闭环 |
| executor | apps/api/src/modules/agents/executor.ts | §9.6 Executor 接口 — AgentLoop 执行面抽象（P0） |
| token-usage.routes | apps/api/src/modules/agents/token-usage.routes.ts | §10.5 角色级 token 视图路由（只读）。 |
| token-usage.service | apps/api/src/modules/agents/token-usage.service.ts | §10.5 角色级 token 滚动视图（只读聚合）。 |
| migrate-members | apps/api/src/modules/channels/migrate-members.ts | §9.5 成员关系统一 — 迁移：把各 profile.channels 合并进对应 channel.members。 |
| manifest-generator | apps/api/src/modules/skills/manifest-generator.ts | manifest-generator |
| skill-demotion-routes | apps/api/src/modules/skills/skill-demotion-routes.ts | §10.6 Skill 降级提案 API 路由 |
| skill-demotion | apps/api/src/modules/skills/skill-demotion.ts | §10.6 skill 生命周期降级通路（聚合 + 降级提案）。 |
| delegation-gate | apps/api/src/modules/workunit/delegation-gate.ts | DelegationGate — A2A 协作委派闸门（2026-07-agent-to-agent-collab-design §4.1 机制 3 / §4.2） |
| system-executor | apps/api/src/modules/agents/system-executor.ts | SystemExecutor - 系统级 LLM 调用执行器（AC-1.6 ~ AC-1.10） |
| review-dispatcher | apps/api/src/modules/agents/review-dispatcher.ts | ReviewDispatcher - AC-4.1 ~ AC-4.5: 状态机驱动的 review 系统代派 |
| remote-executor | apps/api/src/modules/agents/remote-executor.ts | RemoteExecutor — §9.6 P2: 远程节点执行器 |
| discover-proxy | apps/api/src/modules/workspaces/discover-proxy.ts | Discover Proxy — AS-020 P4: Proxy directory discovery through WS |
| webhook.routes | apps/api/src/modules/deploy/webhook.routes.ts | Deploy Webhook — GitHub push 事件触发的部署入口（触发式部署，替代每分钟轮询的主通道） |
| useDetectedProviders | apps/web/src/hooks/useDetectedProviders.ts | 当前运行环境已安装的 agent CLI 列表。 |