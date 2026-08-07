# CAPABILITIES.md

> 最后更新: 2026-07-19

---

| 模块 | 文件 | 说明 |
|------|------|------|
| app | src/app.ts | 注册所有 API 路由（异步，启动时调用一次） |
| studio-cli | src/cli/studio-cli.ts | Studio CLI — 统一入口（2026-05-09: Docker/tmux 已移除） |
| event-store | src/core/event-store.ts | EventStore — EventEmitter + 内存 Map |
| cli-adapter | src/daemon/cli-adapter.ts | CLI Adapter — translate common agent args to provider-specific spawn args |
| cli-scanner | src/daemon/cli-scanner.ts | CLI Scanner — auto-detect available agent CLIs on the system |
| discover-handler | src/daemon/discover-handler.ts | Discover Handler — AS-020 P6-03: Local directory scanning |
| path-sandbox | src/daemon/path-sandbox.ts | Path Sandbox — AS-020 P6-02: Path traversal protection |
| registration | src/daemon/registration.ts | Workspace Registration — HTTP registration flow |
| session-manager | src/daemon/session-manager.ts | Session Manager — manages persistent Claude Code sessions via --session-id + --continue |
| studio-daemon | src/daemon/studio-daemon.ts | Studio Daemon — persistent Agent session manager |
| task-logger | src/daemon/task-logger.ts | Task Logger — 结构化任务日志，供审计/进化/调试 |
| workspace-config | src/daemon/workspace-config.ts | Workspace Config — manage ~/.studio/workspace.json |
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
| requirement-gate | src/modules/agents/requirement-gate.ts | RequirementGate — RequirementsDoc 质量门 (2026-05-21) |
| routes | src/modules/agents/routes.ts | Agent API 路由 |
| session-summary.service | src/modules/agents/session-summary.service.ts | SessionSummaryService — 会话级知识提取 (2026-05-25) |
| triage.service | src/modules/agents/triage/triage.service.ts | Triage Service — incident response: diagnose → classify → act → resolve/escalate |
| types | src/modules/agents/types.ts | Agent 团队类型定义 |
| audit-subscriber | src/modules/audit/audit-subscriber.ts | Audit Event Subscriber — EventBus 审计事件持久化到 DB (B0-002) |
| routes | src/modules/audit-logs/routes.ts | GET /api/audit-logs - 查询审计日志 |
| routes | src/modules/auth/routes.ts | POST /api/v1/auth/guest-session |
| service | src/modules/auth/service.ts | 认证服务 - Auth Service |
| routes | src/modules/builtin-tools/routes.ts | builtin-tools/routes.ts — Built-in Toolset (HZ-026) |
| routes | src/modules/capabilities/routes.ts | 从 YAML 文件读取 stage 字段 |
| channel-init | src/modules/channels/channel-init.ts | Seed default channels on startup (B1-001) |
| channel-message.service | src/modules/channels/channel-message.service.ts | ChannelMessage Service — centralized message creation + event publishing |
| channel.routes | src/modules/channels/channel.routes.ts | Channel Routes — B1-001/B1-002/B1-009/B1-011 |
| requirements-doc.routes | src/modules/channels/requirements-doc.routes.ts | RequirementsDoc edit routes — B2-009 |
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
| wiki.routes | src/modules/wiki/wiki.routes.ts | GET /api/v1/wiki |
| daemon-routes | src/modules/workspaces/daemon-routes.ts | Daemon Routes — AS-020 P5: HTTP Claim + Event Reporting |
| discover-proxy | src/modules/workspaces/discover-proxy.ts | Discover Proxy — AS-020 P4: Proxy directory discovery through WS |
| local-workspace | src/modules/workspaces/local-workspace.ts | Local Workspace Registration — AS-020 P2-04 |
| task-routes | src/modules/workspaces/task-routes.ts | Task Routes — AS-020 P5: UI/Server task management |
| token.routes | src/modules/workspaces/token.routes.ts | Workspace Token Routes — AS-020 P2-05: Token management (admin) |
| workspace.routes | src/modules/workspaces/workspace.routes.ts | Workspace Routes — AS-020 P2: Workspace registration + heartbeat + token management |
| ws-gateway | src/modules/workspaces/ws-gateway.ts | WebSocket Gateway — AS-020 P4: Daemon persistent connection |
| route-registry | src/route-registry.ts | Route Registry - 模块化路由注册 |
| seed-skills | src/scripts/seed-skills.ts | Seed 4 built-in Skills into the Skill table (D6). |
| discord-notifier | src/utils/discord-notifier.ts | Discord 通知工具 |
| errors | src/utils/errors.ts | errors |
| logger | src/utils/logger.ts | Logger 工具 |
| pagination | src/utils/pagination.ts | 分页工具 - 统一 API 分页参数解析和响应格式 |
| response | src/utils/response.ts | 统一响应格式工具 - 规范化 API 响应结构 |
| services | src/utils/services.ts | 创建懒加载单例服务 |

| agent-instance.routes | src/modules/agents/agent-instance.routes.ts | RuntimeInstance API 路由 (AS-026 AC-1) |
| agent-instance.service | src/modules/agents/agent-instance.service.ts | AgentInstance Service — RuntimeInstance CRUD |
| agent-loop | src/modules/agents/loop/agent-loop.ts | Analyze agent log for knowledge search behavior. |
| agent-profile.routes | src/modules/agents/agent-profile.routes.ts | AgentProfile API 路由 (AS-025 Phase 2) |
| agent-profile.service | src/modules/agents/agent-profile.service.ts | AgentProfile Service — 简化 Agent 身份 CRUD |
| default-triggers | src/modules/agents/default-triggers.ts | Default Triggers — 6 system triggers for Agent Network |
| eval-case-store | src/modules/knowledge/eval-case-store.ts | EvalCaseStore — File-based CRUD for eval cases |
| signal-aggregator | src/modules/knowledge/signal-aggregator.ts | Signal Aggregator — 原始 signal 条目 → 聚合趋势摘要 |
| monitoring.routes | src/modules/monitoring/monitoring.routes.ts | Monitoring Routes — Agent Network (MVP-2 + MVP-6) |
| monitoring.service | src/modules/monitoring/monitoring.service.ts | Monitoring Service — Agent Network aggregation (MVP-2 + MVP-6) |
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
