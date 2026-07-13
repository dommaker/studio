# CAPABILITIES.md

> 最后更新: 2026-07-03

---

| 模块 | 文件 | 说明 |
|------|------|------|
| app | src/app.ts | 注册所有 API 路由（异步，启动时调用一次） |
| studio-cli | src/cli/studio-cli.ts | Studio CLI — 统一入口（2026-05-09: Docker/tmux 已移除） |
| database | src/core/database.ts | 数据库连接 - 统一使用 studio-prisma 单例 |
| event-store | src/core/event-store.ts | EventStore — EventEmitter + 内存 Map |
| claim-loop | src/daemon/claim-loop.ts | Claim Loop — AS-020 P5-02: Per-Runtime task polling |
| cli-adapter | src/daemon/cli-adapter.ts | CLI Adapter — translate common agent args to provider-specific spawn args |
| cli-scanner | src/daemon/cli-scanner.ts | CLI Scanner — auto-detect available agent CLIs on the system |
| discover-handler | src/daemon/discover-handler.ts | Discover Handler — AS-020 P6-03: Local directory scanning |
| metrics | src/daemon/metrics.ts | 从 Claude Code stdout 解析 usage（--output-format json） |
| path-sandbox | src/daemon/path-sandbox.ts | Path Sandbox — AS-020 P6-02: Path traversal protection |
| registration | src/daemon/registration.ts | Workspace Registration — HTTP registration flow |
| session-manager | src/daemon/session-manager.ts | Session Manager — manages persistent Claude Code sessions via --session-id + --continue |
| studio-daemon | src/daemon/studio-daemon.ts | Studio Daemon — persistent Agent session manager |
| task-executor | src/daemon/task-executor.ts | Task Executor — AS-020 P5-03: Agent execution lifecycle |
| task-logger | src/daemon/task-logger.ts | Task Logger — 结构化任务日志，供审计/进化/调试 |
| workspace-config | src/daemon/workspace-config.ts | Workspace Config — manage ~/.studio/workspace.json |
| api-cache | src/middleware/api-cache.ts | API 缓存中间件 — 内存 Map |
| audit-logger | src/middleware/audit-logger.ts | 审计日志中间件 - Audit Logger Middleware |
| auth | src/middleware/auth.ts | 认证中间件 - Auth Middleware |
| error-handler | src/middleware/error-handler.ts | 错误处理中间件 |
| rate-limit | src/middleware/rate-limit.ts | Rate Limiting Middleware |
| request-logger | src/middleware/request-logger.ts | 请求日志中间件 |
| docs-freshness.routes | src/modules/admin/docs-freshness.routes.ts | T-020 + T-059: CLAUDE.md + CAPABILITIES.md Freshness Check |
| routes | src/modules/agent-configs/routes.ts | agent-configs/routes.ts — Agent Manager + Version Control (HZ-024, HZ-025) |
| auditor-agent.service | src/modules/agents/auditor-agent.service.ts | Auditor Agent — 跨任务审计 + 周期洞察 |
| deploy-agent.service | src/modules/agents/deploy-agent.service.ts | Deploy Agent — merge to master, push, deploy, cleanup |
| knowledge-agent.service | src/modules/agents/knowledge-agent.service.ts | Knowledge Agent - 从执行结果中异步提取知识 |
| monitor-agent.service | src/modules/agents/monitor-agent.service.ts | Monitor Agent - 健康监控 + NA Step 7 渐进告警 |
| ops-agent.service | src/modules/agents/ops-agent.service.ts | Ops Agent — 系统生命周期守护 |
| ops-rules | src/modules/agents/ops-rules.ts | Ops Rules — 运行时数据，不在代码里 |
| post-eval-agent.service | src/modules/agents/post-eval-agent.service.ts | PostEval Agent — 交付完整性审计 (2026-05-21) |
| requirement-gate | src/modules/agents/requirement-gate.ts | RequirementGate — RequirementsDoc 质量门 (2026-05-21) |
| review-agent.service | src/modules/agents/review-agent.service.ts | Review Agent - 多立场代码审查 (daemon async spawn) |
| review-report | src/modules/agents/review-report.ts | 审查报告类型定义 |
| routes | src/modules/agents/routes.ts | Agent API 路由 |
| session-summary-agent.service | src/modules/agents/session-summary-agent.service.ts | SessionSummaryAgent — 会话级知识提取 (2026-05-25) |
| triage-agent.service | src/modules/agents/triage-agent.service.ts | Triage Agent Service — incident response: diagnose → classify → act → resolve/escalate |
| types | src/modules/agents/types.ts | Agent 团队类型定义 |
| audit-subscriber | src/modules/audit/audit-subscriber.ts | Audit Event Subscriber — EventBus 审计事件持久化到 DB (B0-002) |
| routes | src/modules/audit-logs/routes.ts | GET /api/audit-logs - 查询审计日志 |
| routes | src/modules/auth/routes.ts | POST /api/v1/auth/guest-session |
| service | src/modules/auth/service.ts | 认证服务 - Auth Service |
| routes | src/modules/builtin-tools/routes.ts | builtin-tools/routes.ts — Built-in Toolset (HZ-026) |
| routes | src/modules/capabilities/routes.ts | 从 YAML 文件读取 stage 字段 |
| analyst-executor | src/modules/channels/analyst-executor.ts | Analyst Executor — Claude Code 执行 + 输出验证 |
| analyst-knowledge | src/modules/channels/analyst-knowledge.ts | Analyst Knowledge — 知识加载、保存、段落筛选 |
| analyst-prompt | src/modules/channels/analyst-prompt.ts | Analyst Prompt — prompt 构建逻辑 |
| analyst-trigger.service | src/modules/channels/analyst-trigger.service.ts | Q8: 自动触发 start_execution — 通过内部 HTTP 调用 actions 端点 |
| channel-init | src/modules/channels/channel-init.ts | Seed default channels on startup (B1-001) |
| channel-message.service | src/modules/channels/channel-message.service.ts | ChannelMessage Service — centralized message creation + event publishing |
| channel.routes | src/modules/channels/channel.routes.ts | Channel Routes — B1-001/B1-002/B1-009/B1-011 |
| conversation-converter | src/modules/channels/conversation-converter.ts | Conversation → Pipeline Conversion (AS-020 §6.6 P10) |
| conversation-handler | src/modules/channels/conversation-handler.ts | ConversationHandler — Channel conversation mode (AS-020 §6.4) |
| discovery-exposure.service | src/modules/channels/discovery-exposure.service.ts | Discovery Exposure Service — G33 |
| requirements-doc.routes | src/modules/channels/requirements-doc.routes.ts | RequirementsDoc edit routes — B2-009 |
| routes | src/modules/companies/routes.ts | Company API 路由 |
| routes | src/modules/dingtalk/routes.ts | 钉钉机器人交互回调 |
| command-runner | src/modules/discord/command-runner.ts | B3-002/B3-003: Shared command runner for CLI and Discord |
| routes | src/modules/discord/routes.ts | Discord Interactions Endpoint |
| routes | src/modules/environments/routes.ts | environments/routes.ts — Environment Manager CRUD (HZ-023) |
| event.routes | src/modules/events/event.routes.ts | G30: StudioEvent API Endpoints |
| session-summary-generator | src/modules/events/session-summary-generator.ts | B9-015: SessionSummaryGenerator — server-side session aggregation |
| sse.routes | src/modules/events/sse.routes.ts | HZ-028: Event Stream (SSE) |
| routes | src/modules/executions/routes.ts | Execution API 路由 |
| agent-event-listener | src/modules/goals/agent-event-listener.ts | Agent Event Listener - Facade |
| event-handler | src/modules/goals/event-handler.ts | Event Handler — Agent 事件核心处理逻辑 |
| goal-crud | src/modules/goals/goal-crud.ts | Goal CRUD — 创建/读取/更新/删除操作 |
| goal-lifecycle | src/modules/goals/goal-lifecycle.ts | Goal Lifecycle — 状态转换（pending→executing→succeeded/failed） |
| goal-review | src/modules/goals/goal-review.ts | Goal Review — 审查集成 + 成功处理 + 部署 |
| goal-scheduler | src/modules/goals/goal-scheduler.ts | Goal Scheduler - Facade |
| goal.service | src/modules/goals/goal.service.ts | Goal Service - Facade |
| knowledge-promoter | src/modules/goals/knowledge-promoter.ts | Knowledge Promoter — 知识引用记录 + 完成后知识提取 |
| review-orchestrator | src/modules/goals/review-orchestrator.ts | Review Orchestrator — 审查循环管理 |
| routes | src/modules/goals/routes.ts | Goal API 路由 - Goal 驱动架构 |
| scheduler-dispatch | src/modules/goals/scheduler-dispatch.ts | Scheduler Dispatch — dispatchStep 核心逻辑 + DispatchContext |
| scheduler-integration | src/modules/goals/scheduler-integration.ts | Scheduler Integration — GoalScheduler 类的生命周期和调度循环 |
| scheduler-prompt | src/modules/goals/scheduler-prompt.ts | Scheduler Prompt — prompt 构建、上下文收集、Integration 代码执行 |
| scheduler-queue | src/modules/goals/scheduler-queue.ts | Scheduler Queue — 路由分类、资源管理、队列管理 |
| evolution.service | src/modules/harness/evolution.service.ts | Constraint Evolution Service — 约束规则进化 |
| iron-laws.routes | src/modules/harness/iron-laws.routes.ts | Iron Laws API — 从 runtime-proxy 迁移 (2026-05-14) |
| routes | src/modules/harness/routes.ts | FL-029: Harness Monitoring Routes (T-015) |
| prompt-builder | src/modules/knowledge/consumers/prompt-builder.ts | Unified knowledge injection entry point. |
| decision-chain-extractor | src/modules/knowledge/decision-chain-extractor.ts | DecisionChainExtractor (G-004) — 从 Meeting 辩论 + Goal 执行中提取决策链 |
| unified-query | src/modules/knowledge/engine/unified-query.ts | UnifiedQuery — dual-store unified query layer. |
| env-snapper | src/modules/knowledge/env-snapper.ts | EnvSnapper (G-003) — 系统环境自动快照 |
| eval-case-generator | src/modules/knowledge/eval-case-generator.ts | EvalCaseGenerator — Better-Harness hill-climbing 吸收 |
| evolution-scheduler | src/modules/knowledge/evolution-scheduler.ts | Knowledge Evolution Scheduler |
| evolution.service | src/modules/knowledge/evolution.service.ts | Knowledge Evolution Engine (§12.12) |
| import.routes | src/modules/knowledge/import.routes.ts | Knowledge Import API - 冷启动导入 |
| knowledge-bus.service | src/modules/knowledge/knowledge-bus.service.ts | KnowledgeBus — Agent 间共享知识总线 (H1, 2026-05-21) |
| knowledge-query.service | src/modules/knowledge/knowledge-query.service.ts | KnowledgeQueryService (S8) — 统一知识检索入口 |
| knowledge-service.routes | src/modules/knowledge/knowledge-service.routes.ts | KnowledgeService HTTP API + SSE |
| knowledge-service | src/modules/knowledge/knowledge-service.ts | KnowledgeService — Unified knowledge capability layer |
| knowledge-sync.service | src/modules/knowledge/knowledge-sync.service.ts | KnowledgeSync — 自运转知识同步系统 |
| pattern-miner | src/modules/knowledge/pattern-miner.ts | PatternMiner (G-005) — 从 MCP traces + 审查历史中挖掘交互模式 |
| preference-observer | src/modules/knowledge/preference-observer.ts | PreferenceObserver (G-001) — 从 MCP traces + 路由反馈中推断用户偏好 |
| external-fetcher | src/modules/knowledge/producers/external-fetcher.ts | ExternalFetcher — fetch external docs and ingest as reference knowledge. |
| resolution.service | src/modules/knowledge/resolution.service.ts | ResolutionService — RKB 匹配/创建/验证 |
| routes | src/modules/knowledge/routes.ts | 知识库 API - 公司数字资产管理 |
| rule-scanner | src/modules/knowledge/rule-scanner.ts | RuleScanner (G-002) — 从源码/harness 约束/配置中提取业务规则 |
| routes | src/modules/lark/routes.ts | 飞书机器人交互回调 |
| client | src/modules/llm/client.ts | LLM 客户端 - 支持 OpenAI 兼容 API |
| config.routes | src/modules/llm/config.routes.ts | LLM Config API 路由 |
| config.service | src/modules/llm/config.service.ts | LLM Config Service - 分层配置解析 |
| creation-analyzer | src/modules/llm/creation-analyzer.ts | 创建意图分析器 - 从自然语言生成 Skill/Workflow 配置 |
| intent-analyzer | src/modules/llm/intent-analyzer.ts | LLM 意图分析器 - 使用 /api/v1/llm/chat（统一使用 Studio LLM 配置） |
| proxy | src/modules/llm/proxy.ts | 获取 LLM 配置 |
| admin.routes | src/modules/mcp/admin.routes.ts | MCP Admin Routes — tool management, permissions, audit |
| permission.service | src/modules/mcp/permission.service.ts | MCP Permission Service — role×tool access control + audit logging |
| routes | src/modules/mcp/routes.ts | MCP HTTP Routes |
| server | src/modules/mcp/server.ts | MCP Server - Model Context Protocol 服务器 |
| tool-registry | src/modules/mcp/tool-registry.ts | MCP Tool Registry — dynamic registration, health, rate limiting |
| tools | src/modules/mcp/tools.ts | MCP Tools 定义 |
| init-trace | src/modules/monitoring/init-trace.ts | ⑨: Trace pipeline initialization |
| trace-pipeline.service | src/modules/monitoring/trace-pipeline.service.ts | TracePipelineService — ⑨ 修复 |
| routes | src/modules/notifications/routes.ts | 通知 API 路由 |
| notify.service | src/modules/outbound-notify/notify.service.ts | NotifyService - 通知服务 |
| routes | src/modules/outbound-notify/routes.ts | Notify API 路由 |
| routes | src/modules/outputs/routes.ts | 产出文档 API - 存储和展示执行结果 |
| pipeline-dashboard.routes | src/modules/pipeline-dashboard/pipeline-dashboard.routes.ts | Dogfood Status Dashboard — GET /api/v1/dogfood/status |
| okr.service | src/modules/pmo/okr.service.ts | 🆕 AS-016: 获取当前季度 |
| project.service | src/modules/pmo/project.service.ts | Project Service - PMO 项目管理 |
| routes | src/modules/pmo/routes.ts | GET /api/v1/pmo/project |
| memory-routes | src/modules/roles/memory-routes.ts | Role Memory API 路由 |
| memory.service | src/modules/roles/memory.service.ts | MemoryService - 角色记忆管理 |
| role.service | src/modules/roles/role.service.ts | Role Service — 角色管理 |
| role.types | src/modules/roles/role.types.ts | Role memory types — used by memory.service.ts |
| routes | src/modules/roles/routes.ts | Role API 路由 |
| routes | src/modules/runtime-config/routes.ts | GET /api/v1/runtime-config |
| routes | src/modules/skills/routes.ts | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| skill-loader | src/modules/skills/skill-loader.ts | SkillLoader API Service — DB-driven skill loading with session lifecycle |
| routes | src/modules/spec-reviews/routes.ts | Spec 审查 API 路由 |
| spec-review.service | src/modules/spec-reviews/spec-review.service.ts | Spec 审查服务 |
| routes | src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| skill-extraction.service | src/modules/skills/skill-extraction.service.ts | Skill Extraction Service — 面向新架构 GoalExecution |
| skill-proposal-routes | src/modules/skills/skill-proposal-routes.ts | Skill Proposal API 路由 |
| error-class | src/modules/triage/error-class.ts | Triage ErrorClass — B1-007: 八类错误标签 + 严重度三级 + 策略路由 |
| wiki.routes | src/modules/wiki/wiki.routes.ts | GET /api/v1/wiki |
| daemon-routes | src/modules/workspaces/daemon-routes.ts | Daemon Routes — AS-020 P5: HTTP Claim + Event Reporting |
| discover-proxy | src/modules/workspaces/discover-proxy.ts | Discover Proxy — AS-020 P4: Proxy directory discovery through WS |
| gc-service | src/modules/workspaces/gc-service.ts | GC Service — AS-020 P5: Garbage collection for old tasks and events |
| local-workspace | src/modules/workspaces/local-workspace.ts | Local Workspace Registration — AS-020 P2-04 |
| task-routes | src/modules/workspaces/task-routes.ts | Task Routes — AS-020 P5: UI/Server task management |
| token.routes | src/modules/workspaces/token.routes.ts | Workspace Token Routes — AS-020 P2-05: Token management (admin) |
| workspace.routes | src/modules/workspaces/workspace.routes.ts | Workspace Routes — AS-020 P2: Workspace registration + heartbeat + token management |
| ws-gateway | src/modules/workspaces/ws-gateway.ts | WebSocket Gateway — AS-020 P4: Daemon persistent connection |
| route-registry | src/route-registry.ts | Route Registry - 模块化路由注册 |
| seed-skills | src/scripts/seed-skills.ts | Seed 4 built-in Skills into the Skill table (D6). |
| test-executor | src/test-executor.ts | test-executor |
| crypto | src/utils/crypto.ts | AES-256-GCM 加密工具 |
| discord-notifier | src/utils/discord-notifier.ts | Discord 通知工具 |
| errors | src/utils/errors.ts | errors |
| git | src/utils/git.ts | Git utilities — branch detection, worktree helpers |
| logger | src/utils/logger.ts | Logger 工具 |
| pagination | src/utils/pagination.ts | 分页工具 - 统一 API 分页参数解析和响应格式 |
| response | src/utils/response.ts | 统一响应格式工具 - 规范化 API 响应结构 |
| services | src/utils/services.ts | 创建懒加载单例服务 |

| agent-instance.routes | src/modules/agents/agent-instance.routes.ts | RuntimeInstance API 路由 (AS-026 AC-1) |
| agent-instance.service | src/modules/agents/agent-instance.service.ts | AgentInstance Service — RuntimeInstance CRUD |
| agent-loop | src/modules/agents/agent-loop.ts | Analyze agent log for knowledge search behavior. |
| agent-profile.routes | src/modules/agents/agent-profile.routes.ts | AgentProfile API 路由 (AS-025 Phase 2) |
| agent-profile.service | src/modules/agents/agent-profile.service.ts | AgentProfile Service — 简化 Agent 身份 CRUD |
| default-triggers | src/modules/agents/default-triggers.ts | Default Triggers — 6 system triggers for Agent Network |
| email.service | src/modules/auth/email.service.ts | 邮件服务 - Email Service |
| oauth.routes | src/modules/auth/oauth.routes.ts | GET /auth/:provider |
| oauth.service | src/modules/auth/oauth.service.ts | OAuth 2.0 service for Google and GitHub providers. |
| acgroup-tier | src/modules/channels/acgroup-tier.ts | AC Group modelTier inheritance. |
| analyst-fact-verification | src/modules/channels/analyst-fact-verification.ts | Analyst Fact Verification — 事实验证层 (D6) |
| analyst-prescan | src/modules/channels/analyst-prescan.ts | Analyst PreScan — Rule-based code scope detection (0 LLM tokens) |
| analyst-scout | src/modules/channels/analyst-scout.ts | Analyst Scout — Parallel code exploration sessions |
| analyst-synthesizer | src/modules/channels/analyst-synthesizer.ts | Analyst Synthesizer — Combines Scout reports into RequirementsDoc prompt |
| contract-test-red-check | src/modules/channels/contract-test-red-check.ts | Contract Test RED Check — Layer 4: 执行测试验证 RED 状态 |
| contract-test-validator | src/modules/channels/contract-test-validator.ts | Contract Test Validator — Layer 1-3 质量检查 |
| multi-repo-split | src/modules/channels/multi-repo-split.ts | P3: Multi-repo WorkUnit splitting |
| sdd-verification | src/modules/channels/sdd-verification.ts | SP-004: SDD read path verification (non-blocking enrichment) |
| eval-case-store | src/modules/knowledge/eval-case-store.ts | EvalCaseStore — File-based CRUD for eval cases |
| improver-scheduler.service | src/modules/knowledge/improver-scheduler.service.ts | ImproverScheduler — 自文档化调度器 |
| signal-aggregator | src/modules/knowledge/signal-aggregator.ts | Signal Aggregator — 原始 signal 条目 → 聚合趋势摘要 |
| monitoring.routes | src/modules/monitoring/monitoring.routes.ts | Monitoring Routes — Agent Network (MVP-2 + MVP-6) |
| monitoring.service | src/modules/monitoring/monitoring.service.ts | Monitoring Service — Agent Network aggregation (MVP-2 + MVP-6) |
| sdd-freshness.service | src/modules/sdd/sdd-freshness.service.ts | SDD Doc Freshness Service |
| failure-classifier | src/modules/shared/failure-classifier.ts | Failure classifier — pattern matching on error messages |
| manifest-loader | src/modules/skills/manifest-loader.ts | manifest-loader (AS-025 3.28c-5) |
| proposal-store | src/modules/skills/proposal-store.ts | ProposalStore — File-based CRUD for SkillProposal |
| skill-selector | src/modules/skills/skill-selector.ts | skill-selector (AS-025 3.28c-5) |
| skill-store | src/modules/skills/skill-store.ts | SkillStore — File-based CRUD for Skill metadata |
| cron-matcher | src/modules/triggers/cron-matcher.ts | Cron Matcher — minimal cron expression evaluator (3.28c-4) |
| trigger-action | src/modules/triggers/trigger-action.ts | Execute a CREATE action — creates a WorkUnit from trigger payload. |
| trigger-registry | src/modules/triggers/trigger-registry.ts | Trigger Registry — singleton TriggerScheduler instance |
| trigger-scheduler | src/modules/triggers/trigger-scheduler.ts | Register a trigger programmatically. |
| trigger-store | src/modules/triggers/trigger-store.ts | Trigger Store — YAML-based trigger config persistence (3.28c-4) |
| trigger.routes | src/modules/triggers/trigger.routes.ts | Trigger Routes — REST API for trigger management (3.28c-4) |
| trigger.types | src/modules/triggers/trigger.types.ts | Trigger Registry Types (3.28c-4, AS-026 extended) |
| wiki.service | src/modules/wiki/wiki.service.ts | Wiki service — SDD-based read logic |
| workunit.routes | src/modules/workunit/workunit.routes.ts | WorkUnit API 路由 (AS-025 §3.28c-1, §5.16) |
| workunit.service | src/modules/workunit/workunit.service.ts | WorkUnit Service — 工作单元 CRUD + Claim + 状态机 |