# CAPABILITIES.md

> 最后更新: 2026-08-08

---

| 模块 | 文件 | 说明 |
|------|------|------|

| types | packages/studio-agent/src/types.ts | studio-agent 类型定义 |
| audit-service | packages/studio-audit/src/services/audit-service.ts | Audit Service - 审计日志服务 (AR-012) |
| capability.service | packages/studio-capability/src/services/capability.service.ts | Capability Service - 能力管理服务 |
| notification-service | packages/studio-notification/src/services/notification-service.ts | 通知服务 |
| command | packages/studio-shared/src/cli/command.ts | 命令注册框架 |
| config | packages/studio-shared/src/cli/config.ts | 配置加载器 |
| error | packages/studio-shared/src/cli/error.ts | 错误处理 |
| formatter | packages/studio-shared/src/cli/formatter.ts | 输出格式化器 |
| parser | packages/studio-shared/src/cli/parser.ts | 参数解析器 |
| levels | packages/studio-shared/src/constants/levels.ts | 级别配置 - 全局统一的职级定义 |

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

| system-executor | apps/api/src/modules/agents/system-executor.ts | SystemExecutor — 系统级 LLM 调用抽象，替代 modelGateway |
| memory-store | packages/studio-shared/src/memory-store.ts | MemoryStore — 内存替代 Redis (B0-011) |
| node | packages/studio-shared/src/node.ts | Node.js 专用入口 — 包含 CLI 和 Config 模块 |
| goal-status | packages/studio-shared/src/types/goal-status.ts | Goal 状态类型 — SQLite 不支持 enum，用 TypeScript 类型守卫约束 |
| resolution | packages/studio-shared/src/types/resolution.ts | Resolution types — RKB (Resolution Knowledge Base) |
| stance | packages/studio-shared/src/types/stance.ts | 立场系统类型定义 |
| logger | packages/studio-shared/src/utils/logger.ts | Shared Logger - 统一日志接口 |
| process-io | packages/studio-shared/src/utils/process-io.ts | Process I/O utilities — spawn, session-id persistence, file bridge |
| spec-parser | packages/studio-shared/src/utils/spec-parser.ts | Spec Markdown 解析器 |
| loader | packages/studio-skill/src/loader.ts | SkillLoader — 按 trigger 加载 Skill，注入 Agent prompt |
| types | packages/studio-skill/src/types.ts | Skill 定义类型 |
| change-analyzer.service.test | packages/studio-spec/src/services/change-analyzer.service.test.ts | ChangeAnalyzerService 单元测试 |
| change-analyzer.service | packages/studio-spec/src/services/change-analyzer.service.ts | 变更分析服务 |
| change-history.service.test | packages/studio-spec/src/services/change-history.service.test.ts | ChangeHistoryService 单元测试 |
| change-history.service | packages/studio-spec/src/services/change-history.service.ts | 变更历史服务 |
| gate-checker.service.test | packages/studio-spec/src/services/gate-checker.service.test.ts | GateCheckerService 单元测试 |
| gate-checker.service | packages/studio-spec/src/services/gate-checker.service.ts | 门禁检查服务 |
| change.types | packages/studio-spec/src/types/change.types.ts | Spec 变更分级类型定义 |
| gate.types | packages/studio-spec/src/types/gate.types.ts | 门禁类型定义 |
| docs-freshness.routes | apps/api/src/modules/admin/docs-freshness.routes.ts | T-020 + T-059: CLAUDE.md + CAPABILITIES.md Freshness Check |
| routes | apps/api/src/modules/agent-configs/routes.ts | agent-configs/routes.ts — Agent Manager + Version Control (HZ-024, HZ-025) |
| auditor.service | apps/api/src/modules/agents/auditor/auditor.service.ts | Auditor Service — 跨任务审计 + 周期洞察 |
| knowledge-curator.service | apps/api/src/modules/agents/knowledge/knowledge-curator.service.ts | Knowledge Curator - 知识库冷启动 + F1 每日维护 + 提取 prompt 单一来源 |
| monitor.service | apps/api/src/modules/agents/monitor/monitor.service.ts | Monitor Service - 健康监控 + 渐进告警 + G31 知识沉淀闸门(precipitate→TTL) |
| ops.service | apps/api/src/modules/agents/ops/ops.service.ts | Ops Service — 系统生命周期守护 |
| ops-rules | apps/api/src/modules/agents/ops/ops-rules.ts | Ops Rules — 运行时数据，不在代码里 |
| requirement-gate | apps/api/src/modules/agents/requirement-gate.ts | RequirementGate — RequirementsDoc 质量门 (2026-05-21) |
| review.service | apps/api/src/modules/agents/review.service.ts | Review Service - 跨分支 diff 多立场审查（/review/diff 管理端点）+ G33 非阻断发现自动曝光 |
| review-report | apps/api/src/modules/agents/review-report.ts | 审查报告类型定义 |
| routes | apps/api/src/modules/agents/routes.ts | Agent API 路由 |
| session-summary.service | apps/api/src/modules/agents/session-summary.service.ts | SessionSummaryService — 会话级知识提取 (2026-05-25) |
| triage.service | apps/api/src/modules/agents/triage/triage.service.ts | Triage Service — incident response: diagnose → classify → act → resolve/escalate |
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
| requirements-doc.routes | apps/api/src/modules/channels/requirements-doc.routes.ts | RequirementsDoc edit routes — B2-009 |
| routes | apps/api/src/modules/dingtalk/routes.ts | 钉钉机器人交互回调 |
| command-runner | apps/api/src/modules/discord/command-runner.ts | B3-002/B3-003: Shared command runner for CLI and Discord |
| routes | apps/api/src/modules/discord/routes.ts | Discord Interactions Endpoint |
| event.routes | apps/api/src/modules/events/event.routes.ts | G30: StudioEvent API Endpoints |
| sse.routes | apps/api/src/modules/events/sse.routes.ts | HZ-028: Event Stream (SSE) |
| routes | apps/api/src/modules/executions/routes.ts | Execution API 路由 |
| iron-laws.routes | apps/api/src/modules/harness/iron-laws.routes.ts | Iron Laws API — 从 runtime-proxy 迁移 (2026-05-14) |
| routes | apps/api/src/modules/harness/routes.ts | FL-029: Harness Monitoring Routes (T-015) |
| decision-chain-extractor | apps/api/src/modules/knowledge/decision-chain-extractor.ts | DecisionChainExtractor (G-004) — 从 Meeting 辩论 + Goal 执行中提取决策链 |
| env-snapper | apps/api/src/modules/knowledge/env-snapper.ts | EnvSnapper (G-003) — 系统环境自动快照 |
| eval-case-generator | apps/api/src/modules/knowledge/eval-case-generator.ts | EvalCaseGenerator — Better-Harness hill-climbing 吸收 |

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

| admin.routes | apps/api/src/modules/mcp/admin.routes.ts | MCP Admin Routes — tool management, permissions, audit |
| permission.service | apps/api/src/modules/mcp/permission.service.ts | MCP Permission Service — role×tool access control + audit logging |
| routes | apps/api/src/modules/mcp/routes.ts | MCP HTTP Routes |
| server | apps/api/src/modules/mcp/server.ts | MCP Server - Model Context Protocol 服务器 |

| tools | apps/api/src/modules/mcp/tools.ts | MCP Tools 定义 — 含 createWorkUnit (PMO→Channel→Agent) |
| routes | apps/api/src/modules/notifications/routes.ts | 通知 API 路由 |
| notify.service | apps/api/src/modules/outbound-notify/notify.service.ts | NotifyService - 通知服务 |
| routes | apps/api/src/modules/outbound-notify/routes.ts | Notify API 路由 |
| okr.service | apps/api/src/modules/pmo/okr.service.ts | 🆕 AS-016: 获取当前季度 |
| project.service | apps/api/src/modules/pmo/project.service.ts | Project Service - PMO 项目管理 + publish() → Channel + getLinkedSDDs() |
| routes | apps/api/src/modules/pmo/routes.ts | PMO API — 项目 CRUD + POST publish + GET sdd 关联查询 |
| routes | apps/api/src/modules/skills/routes.ts | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| routes | apps/api/src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| skill-extraction.service | apps/api/src/modules/skills/skill-extraction.service.ts | Skill Extraction Service — 面向新架构 GoalExecution |
| skill-proposal-routes | apps/api/src/modules/skills/skill-proposal-routes.ts | Skill Proposal API 路由 |
| error-class | apps/api/src/modules/triage/error-class.ts | Triage ErrorClass — B1-007: 八类错误标签 + 严重度三级 + 策略路由 |
| wiki.routes | apps/api/src/modules/wiki/wiki.routes.ts | GET /api/v1/wiki |
| channel | apps/web/src/api/channel.ts | Channel API — list + publish 发布 |
| useChannelEvents | apps/web/src/hooks/useChannelEvents.ts | Channel SSE hook — B2: EventSource 实时推送替代 3s 轮询 |
| useGlobalModals | apps/web/src/hooks/useGlobalModals.ts | 全局弹窗状态 hook |
| useWebSocketHandlers | apps/web/src/hooks/useWebSocketHandlers.ts | WebSocket 事件处理 hook |
| agentStore | apps/web/src/stores/agentStore.ts | agentStore |
| authStore | apps/web/src/stores/authStore.ts | 认证状态管理 - Auth Store (Zustand) |
| runtimeStore | apps/web/src/stores/runtimeStore.ts | runtimeStore |
| uiStore | apps/web/src/stores/uiStore.ts | uiStore |
| setup | apps/web/src/test/setup.ts | setup |
| types | apps/web/src/types.ts | types.ts - Agent Studio 类型定义 |
| api | apps/web/src/utils/api.ts | 获取 API 基础 URL |
| format | apps/web/src/utils/format.ts | 格式化 Token 数量 |
| toast | apps/web/src/utils/toast.ts | Lightweight toast notification system (zero dependencies) |

| session-summary-generator | apps/api/src/modules/events/session-summary-generator.ts | B9-015: SessionSummaryGenerator — server-side session aggregation |
| output-capture | packages/studio-agent/src/services/output-capture.ts | Output Capture — 进度读取 + 输出文件收集 + session 指标记录 |

| worktree-resolver | packages/studio-agent/src/services/worktree-resolver.ts | Worktree Resolver — git worktree 创建 + harness 配置传播 + 文件桥 |
| skill-loader | apps/api/src/modules/skills/skill-loader.ts | SkillLoader API Service — DB-driven skill loading with session lifecycle |

| daemon-routes | apps/api/src/modules/workspaces/daemon-routes.ts | Daemon Routes — AS-020 P5: HTTP Claim + Event Reporting |
| local-workspace | apps/api/src/modules/workspaces/local-workspace.ts | Local Workspace Registration — AS-020 P2-04 |
| token.routes | apps/api/src/modules/workspaces/token.routes.ts | Workspace Token Routes — AS-020 P2-05: Token management (admin) |
| workspace.routes | apps/api/src/modules/workspaces/workspace.routes.ts | Workspace Routes — AS-020 P2: Workspace registration + heartbeat + token management |
| agent-runner | packages/studio-agent/src/services/agent-runner.ts | Agent Runner — unified executor merging AgentExecutor + TaskExecutor |

| stream-json-parser | packages/studio-shared/src/llm/stream-json-parser.ts | Stream-JSON Parser — 解析 Claude CLI --output-format stream-json 输出 |

| unified-query | apps/api/src/modules/knowledge/engine/unified-query.ts | UnifiedQuery — dual-store unified query layer. |
| knowledge-service.routes | apps/api/src/modules/knowledge/knowledge-service.routes.ts | KnowledgeService HTTP API + SSE |
| knowledge-service | apps/api/src/modules/knowledge/knowledge-service.ts | KnowledgeService — Unified knowledge capability layer |
| signal-aggregator | apps/api/src/modules/knowledge/signal-aggregator.ts | Signal Aggregator — 原始 signal 条目 → 趋势聚合摘要（≥3次/7天） |
| external-fetcher | apps/api/src/modules/knowledge/producers/external-fetcher.ts | ExternalFetcher — fetch external docs and ingest as reference knowledge. |
| sdd-utils | packages/studio-shared/src/utils/sdd-utils.ts | SDD 工具函数 — frontmatter 解析 + slug 生成 |

| agent-instance.routes | apps/api/src/modules/agents/agent-instance.routes.ts | RuntimeInstance API 路由 (AS-026 AC-1) |
| agent-instance.service | apps/api/src/modules/agents/agent-instance.service.ts | AgentInstance Service — RuntimeInstance CRUD |
| agent-loop | apps/api/src/modules/agents/loop/agent-loop.ts | Analyze agent log for knowledge search behavior. |
| agent-profile.routes | apps/api/src/modules/agents/agent-profile.routes.ts | AgentProfile API 路由 (AS-025 Phase 2) |
| agent-profile.service | apps/api/src/modules/agents/agent-profile.service.ts | AgentProfile Service — 简化 Agent 身份 CRUD |
| default-triggers | apps/api/src/modules/agents/default-triggers.ts | Default Triggers — 6 system triggers for Agent Network |
| eval-case-store | apps/api/src/modules/knowledge/eval-case-store.ts | EvalCaseStore — File-based CRUD for eval cases |
| monitoring.routes | apps/api/src/modules/monitoring/monitoring.routes.ts | Monitoring Routes — Agent Network (MVP-2 + MVP-6) |
| monitoring.service | apps/api/src/modules/monitoring/monitoring.service.ts | Monitoring Service — Agent Network aggregation (MVP-2 + MVP-6) |
| manifest-loader | apps/api/src/modules/skills/manifest-loader.ts | manifest-loader (AS-025 3.28c-5) |
| proposal-store | apps/api/src/modules/skills/proposal-store.ts | ProposalStore — File-based CRUD for SkillProposal |
| skill-selector | apps/api/src/modules/skills/skill-selector.ts | skill-selector (AS-025 3.28c-5) |
| skill-store | apps/api/src/modules/skills/skill-store.ts | SkillStore — File-based CRUD for Skill metadata |
| cron-matcher | apps/api/src/modules/triggers/cron-matcher.ts | Cron Matcher — minimal cron expression evaluator (3.28c-4) |
| trigger-action | apps/api/src/modules/triggers/trigger-action.ts | Execute a CREATE action — creates a WorkUnit from trigger payload. |

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

| file-store | packages/studio-shared/src/file-store.ts | FileStore — AN 运行时数据文件存储基类 |
| anomaly-detector | packages/studio-shared/src/stats/anomaly-detector.ts | 计算数组的均值和标准差（总体标准差） |
| system-health | apps/api/src/modules/agents/ops/system-health.ts | 系统健康采集模块（纯代码，零 LLM） |
| convert-to-task.service | apps/api/src/modules/channels/convert-to-task.service.ts | AC-E2: Convert to Task Service |
| message-routing | apps/api/src/modules/channels/message-routing.ts | Message routing logic for channel messages (AC-B1-B4). |
| project-discovery.service | apps/api/src/modules/projects/project-discovery.service.ts | AC-D1+D3: Project Discovery Service |
| project.routes | apps/api/src/modules/projects/project.routes.ts | AC-D3: Project Discovery API |
| providers | packages/studio-shared/src/providers.ts | Provider Registry — single source of truth for agent CLI providers (F4) |

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
| auditor-execution | apps/api/src/modules/agents/auditor/auditor-execution.ts | Auditor Agent — 建议执行 / 升级 / 闭环 |
| auditor-reports | apps/api/src/modules/agents/auditor/auditor-reports.ts | Auditor Agent — 洞察与报告输出 |
| auditor-rules | apps/api/src/modules/agents/auditor/auditor-rules.ts | Auditor Agent — 审计规则（检测 → 建议） |
| knowledge-cold-start | apps/api/src/modules/agents/knowledge/knowledge-cold-start.ts | Knowledge Agent — 冷启动子模块 |
| knowledge-extraction | apps/api/src/modules/agents/knowledge/knowledge-extraction.ts | Knowledge Agent — 提取 prompt 单一来源 |
| knowledge-maintenance | apps/api/src/modules/agents/knowledge/knowledge-maintenance.ts | Knowledge Agent — 语料分析（每日维护）子模块 |
| monitor-alerts | apps/api/src/modules/agents/monitor/monitor-alerts.ts | Monitor Agent — 告警分发 / Triage 升级 / 事件写入 |
| monitor-lifecycle | apps/api/src/modules/agents/monitor/monitor-lifecycle.ts | Monitor Agent — G31 数据生命周期：知识沉淀闸门 + TTL 清理 |
| monitor-probes | apps/api/src/modules/agents/monitor/monitor-probes.ts | Monitor Agent — 任务/WorkUnit 级探测 |
| monitor-reports | apps/api/src/modules/agents/monitor/monitor-reports.ts | Monitor Agent — 报告：轨迹评估 / 每日洞察 / 交互模式观察 |
| monitor-system-probes | apps/api/src/modules/agents/monitor/monitor-system-probes.ts | Monitor Agent — 系统/知识级探测与自修复 |
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

| useChannelList | apps/web/src/hooks/useChannelList.ts | 频道列表数据 hook —— ChannelListPage 与 Mission Control 左栏 ChannelRail 共用 |
| knowledge | apps/web/src/api/knowledge.ts | Knowledge Service API — 2026-07 知识审核闭环 |
| executor | apps/api/src/modules/agents/loop/executor.ts | §9.6 Executor 接口 — AgentLoop 执行面抽象（P0） |
| token-usage.routes | apps/api/src/modules/agents/token-usage.routes.ts | §10.5 角色级 token 视图路由（只读）。 |
| token-usage.service | apps/api/src/modules/agents/token-usage.service.ts | §10.5 角色级 token 滚动视图（只读聚合）。 |
| migrate-members | apps/api/src/modules/channels/migrate-members.ts | §9.5 成员关系统一 — 迁移：把各 profile.channels 合并进对应 channel.members。 |
| manifest-generator | apps/api/src/modules/skills/manifest-generator.ts | manifest-generator |
| skill-demotion-routes | apps/api/src/modules/skills/skill-demotion-routes.ts | §10.6 Skill 降级提案 API 路由 |
| skill-demotion | apps/api/src/modules/skills/skill-demotion.ts | §10.6 skill 生命周期降级通路（聚合 + 降级提案）。 |
| delegation-gate | apps/api/src/modules/workunit/delegation-gate.ts | DelegationGate — A2A 协作委派闸门（2026-07-agent-to-agent-collab-design §4.1 机制 3 / §4.2） |
| system-executor | apps/api/src/modules/agents/system-executor.ts | SystemExecutor - 系统级 LLM 调用执行器（AC-1.6 ~ AC-1.10） |
| review-dispatcher | apps/api/src/modules/agents/loop/review-dispatcher.ts | ReviewDispatcher - AC-4.1 ~ AC-4.5: 状态机驱动的 review 系统代派 |
| remote-executor | apps/api/src/modules/agents/loop/remote-executor.ts | RemoteExecutor — §9.6 P2: 远程节点执行器 |
| discover-proxy | apps/api/src/modules/workspaces/discover-proxy.ts | Discover Proxy — AS-020 P4: Proxy directory discovery through WS |
| webhook.routes | apps/api/src/modules/deploy/webhook.routes.ts | Deploy Webhook — GitHub push 事件触发的部署入口（触发式部署，替代每分钟轮询的主通道） |
| useDetectedProviders | apps/web/src/hooks/useDetectedProviders.ts | 当前运行环境已安装的 agent CLI 列表。 |

| metrics.service | apps/api/src/modules/monitoring/metrics.service.ts | D16 监控指标聚合（B5）— 任务流健康 / 入口转化 / 人工干预 / 周期 / 角色 / 工程质量 / Token / 告警。 |
| progress-rollup | apps/api/src/modules/pmo/progress-rollup.ts | B3a 工程归属链（决策 D2）：PMO 项目进度回写。 |
| ownership-resolver | apps/api/src/modules/requirements/ownership-resolver.ts | B3a 工程归属链（决策 D2）— WorkUnit 创建时的工程归属解析。 |
| skill-promotion | apps/api/src/modules/skills/skill-promotion.ts | D11 skill promote 门禁（draft → published）。 |
| merge-on-review-pass | apps/api/src/modules/workunit/merge-on-review-pass.ts | B3b-ii 评审通过后自动合并（决策 D1/D3 后半） |
| timeout-release | apps/api/src/modules/workunit/timeout-release.ts | P0 修复（WU 超时机制）：workunit-timeout 触发器的 EXECUTE handler。 |
| domain-vocab | packages/studio-shared/src/domain-vocab.ts | 职能域词表（决策 8，docs/plans/2026-07-27-agents-md-skill-governance.md） |
| agent-registry | packages/studio-agent/src/services/agent-registry.ts | 注册新 Agent |
| agent-loop-registry | apps/api/src/modules/agents/loop/agent-loop-registry.ts | AgentLoopRegistry — profileId → running AgentLoop (F1: AgentLoop 动态挂载) |
| tool-registry | apps/api/src/modules/mcp/tool-registry.ts | MCP Tool Registry — dynamic registration, health, rate limiting |
| trigger-registry | apps/api/src/modules/triggers/trigger-registry.ts | Trigger Registry — singleton TriggerScheduler instance |
| default-provider | apps/api/src/modules/agents/default-provider.ts | F1 provider 默认选取工具（2026-07-28 内置角色与信任模型分析，决策见 |
| attestation | packages/studio-shared/src/attestation.ts | F6 信任证据模型（2026-07-28 内置角色与流水线信任模型分析，决策 1） |
| delivery | apps/api/src/modules/pmo/delivery.ts | PMO-b（2026-07-28 分析文档 §4.5，决策 1）：交付守卫与台账。 |
| pmo-branch-resolver | apps/api/src/modules/requirements/pmo-branch-resolver.ts | PMO-b（2026-07-28 分析文档 §4.5，决策 3）：WU → PMO 分支解析。 |
| web | packages/studio-shared/src/web.ts | 前端专用入口 - 仅导出无 Node 依赖的纯逻辑/类型模块 |
| workunit-events-bridge | apps/api/src/modules/events/workunit-events-bridge.ts | WorkUnit 事件 → SSE 桥 |
| analysis-handoff | apps/api/src/modules/pmo/analysis-handoff.ts | Analysis Handoff — PMO 分析接力（分析结论 → 拆任务 → 派工） |
| useWorkUnitEvents | apps/web/src/hooks/useWorkUnitEvents.ts | WorkUnit 事件订阅 — workunit.created / workunit.status_changed（SSE） |
| execution-step-events | apps/api/src/modules/agents/loop/execution-step-events.ts | 执行步事件（WU 过程可视化） |
| useWorkUnitStreamEvents | apps/web/src/hooks/useWorkUnitStreamEvents.ts | WU 步内流式订阅（Layer B）— SSE `workunit.execution.stream` 实时 chunk |
| wu-verification | apps/api/src/modules/agents/loop/wu-verification.ts | B3b-i（决策 D3 前半）WU 自动验证 —— 从 agent-loop 抽出的可复用实现（2026-07-30 F6-c 断链修复）。 |
| evidence-summary | apps/api/src/modules/pmo/evidence-summary.ts | PMO 证据台账共享口径（2026-07-30 抽取）：delivery.ts 台账与 progress-rollup.ts |
| pipelineUtils | apps/web/src/components/pmo/pipelineUtils.ts | WU → 泳道。F6 铁律：分列只准看 deriveDisplayState 派生列（done 缺 L3 回「评审中」等人工确认）。 |
| agentStatus | apps/web/src/utils/agentStatus.ts | 状态推导：instance.status + 当前 WU.status → 卡片状态键。 |
| daily-token-budget | apps/api/src/modules/agents/loop/daily-token-budget.ts | C3（2026-08-03 unattended-token-burn issue P2-2，决策记录 #4）：每日 token 预算熔断。 |
| maintenance.routes | apps/api/src/modules/knowledge/maintenance.routes.ts | Knowledge Maintenance Routes — F1 知识库维护的手动触发入口 |
| maintenance | apps/web/src/api/maintenance.ts | Maintenance API — 手动任务按钮（触发器手动 fire / 成本聚合 / 知识库维护 / 中层演化） |
| runner-briefing | packages/studio-agent/src/services/runner-briefing.ts | Runner Briefing — "agent 被告知的內容"的 worktree 文件桥 |
| id | packages/studio-shared/src/utils/id.ts | 生成带前缀的唯一 ID：`${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`。 |
| vps-workspace | packages/studio-shared/src/vps-workspace.ts | VPS Workspace 解析 — 'VPS' 命名约定 + ~/.studio/workspaces 读取的唯一属主 |
| agent-loop-events | apps/api/src/modules/agents/loop/agent-loop-events.ts | 非缓存执行 tokens（CLI usage input+output，不含 cache）。CLI 未回报 usage 时传 null —— |
| agent-loop-guards | apps/api/src/modules/agents/loop/agent-loop-guards.ts | AgentLoop 守卫函数区（2026-08 工单 28 从 agent-loop.ts 原样抽出，行为不变）： |
| agent-loop-parsers | apps/api/src/modules/agents/loop/agent-loop-parsers.ts | P0 修复（reviewReport 回传断链）：解析 reviewer 最终输出为结构化审查结论。 |
| agent-loop.types | apps/api/src/modules/agents/loop/agent-loop.types.ts | AgentLoop 类型契约（2026-08 工单 28 从 agent-loop.ts 原样抽出，行为不变）： |
| completion-gates | apps/api/src/modules/agents/loop/completion-gates.ts | 收口守卫链（2026-08 从 agent-loop.recordResult 抽出，行为一字不改）： |
| review-contract | apps/api/src/modules/agents/loop/review-contract.ts | Review Contract — 审查结论（verdict）语义的单一来源 |
| conversation-extractor | apps/api/src/modules/knowledge/conversation-extractor.ts | conversation-extractor — R3 会话提取管道 + 审核闭环提案卡。 |
| knowledge-form-gate | apps/api/src/modules/knowledge/knowledge-form-gate.ts | knowledge-form-gate — 知识形态门禁（knowledge / data / skill / rule 判定）。 |
| knowledge-metrics | apps/api/src/modules/knowledge/knowledge-metrics.ts | knowledge-metrics — KnowledgeService 的 Measure 能力带（飞轮度量 / 健康 / 审计 / 准确度）。 |
| knowledge-semantic-search | apps/api/src/modules/knowledge/knowledge-semantic-search.ts | knowledge-semantic-search — mcp-local-rag 语义检索支撑。 |
| trend-data | apps/api/src/modules/knowledge/trend-data.ts | trend-data — 趋势数据层（~/.studio/data/trends/ 目录写入）。 |
| metrics-aggregate | apps/api/src/modules/monitoring/metrics-aggregate.ts | D16 聚合核心纯函数（工单 30 自 metrics.service.ts 纯函数区抽出，纯搬运零逻辑变更）： |
| metrics.types | apps/api/src/modules/monitoring/metrics.types.ts | D16 监控指标类型契约（工单 30 自 metrics.service.ts 类型区抽出，纯搬运零逻辑变更）： |
| wu-pmo-attribution | apps/api/src/modules/requirements/wu-pmo-attribution.ts | WU → PMO 创建期归因戳（2026-08 归因统一）：canonical metadata key = `pmoId`。 |
| assignee-resolver | apps/api/src/modules/workunit/assignee-resolver.ts | assigneeId 双语义批量解析器（语义权威：workunit/CONTEXT.md「assigneeId 双语义」条）。 |
| workunit.mappers | apps/api/src/modules/workunit/workunit.mappers.ts | WorkUnit 快照 ↔ DTO 转换层（工单 30 自 workunit.service.ts 抽出，纯搬运零逻辑变更）。 |
| workunit.types | apps/api/src/modules/workunit/workunit.types.ts | WorkUnit 类型契约 + 状态机表/超时常量（工单 30 自 workunit.service.ts 头部抽出，纯搬运零逻辑变更）。 |
| wu-messenger | apps/api/src/modules/workunit/wu-messenger.ts | WU 频道系统消息统一出口（wu-messenger）。 |
| wu-metadata | apps/api/src/modules/workunit/wu-metadata.ts | WU metadata 访问器（2026-08-06 Card 8）：WorkUnitMetadata 的容错解析 / 会话簿记清理 / |
| auditLogs | apps/web/src/api/auditLogs.ts | 导出为文件下载 URL（浏览器跳转触发下载）。 |
| company | apps/web/src/api/company.ts | Company API — 公司 CRUD（FileStore 存储；Settings 页 / PMOPage 共用） |
| harness | apps/web/src/api/harness.ts | Harness API — /harness/*（T-015 Harness 监控集成，admin 中间件） |
| notify | apps/web/src/api/notify.ts | Notify API — 用户通知渠道配置（服务端持久化到 ~/.studio/notify-config.json；Settings 页「已同步/需重存」提示 + 保存） |
| pmo | apps/web/src/api/pmo.ts | PMO OKR API — /pmo/okr（PMOPage OKR 列表/新建、PMOCard 统计） |
| graphUtils | apps/web/src/components/knowledge/graphUtils.ts | 知识图谱节点数据 |
| okrMetric | apps/web/src/components/pmo/okrMetric.ts | okrMetric - OKR/KR 度量纯函数与常量（零依赖，自 PMOPage 抽出，工单 33） |
| useAgentRoster | apps/web/src/hooks/useAgentRoster.ts | Agent 作战视图数据 hook — 角色名册（profile × runtime 合并）+ SSE 事件路由 + 轮询兜底 |
| delegate-branch | apps/api/src/modules/agents/loop/delegate-branch.ts | A2A §4.1 DELEGATE 分支（2026-08 从 agent-loop.recordResult 抽出，行为一字不改）： |
| prompt-composer | apps/api/src/modules/agents/loop/prompt-composer.ts | prompt/上下文组装（2026-08 从 agent-loop.agentStep 抽出，行为一字不改）： |
| evolution-scheduler | apps/api/src/modules/knowledge/evolution-scheduler.ts | Knowledge Evolution Scheduler |
| trigger-scheduler | apps/api/src/modules/triggers/trigger-scheduler.ts | Register a trigger programmatically. |
| websocketHooks | apps/web/src/api/websocketHooks.ts | SSE 客户端 hooks — 从 websocket.tsx 拆出（类型 / useWebSocket / context / useWebSocketContext）， |
| statusClasses | apps/web/src/components/channel/statusClasses.ts | 频道/agent 状态点样式映射（从 ChannelRail.tsx 拆出，供 ChannelRail 与 ChannelListPage 共用） |
| dismissed | apps/web/src/components/setup/dismissed.ts | 角色配置引导弹框的会话级 dismiss 标记（sessionStorage key 与检查函数； |
| useTheme | apps/web/src/contexts/useTheme.ts | 使用主题 Hook |
| prerequisite-checks | packages/studio-agent/src/services/prerequisite-checks.ts | Prerequisite Checks — 执行前置检查（session-manager.ts 拆分模块） |
| prompt-builder | packages/studio-agent/src/services/prompt-builder.ts | Prompt Builder — Agent prompt 构建（session-manager.ts 拆分模块） |
| worktree-scaffolding | packages/studio-agent/src/services/worktree-scaffolding.ts | Worktree Scaffolding — worktree 内的脚手架写入：REQUIREMENTS.md / 契约测试 / 依赖缓存安装 |
| channels-codec | packages/studio-shared/src/channels-codec.ts | channels/members 字段编解码（F3，从 file-store.ts 抽出） |
| file-store-base | packages/studio-shared/src/file-store-base.ts | FileStoreBase — FileStore 的底层原语层（从 file-store.ts 抽出） |
| file-store-types | packages/studio-shared/src/file-store-types.ts | file-store 数据类型定义（从 file-store.ts 抽出） |
| file-store-workunit | packages/studio-shared/src/file-store-workunit.ts | FileStoreWorkUnitBase — FileStore 的 WorkUnit 事件溯源层（从 file-store.ts 抽出） |
| frontmatter | packages/studio-shared/src/frontmatter.ts | 解析 markdown 文件的 YAML frontmatter。 |
| agent-knowledge-analysis | apps/api/src/modules/agents/agent-knowledge-analysis.ts | Analyze agent log for knowledge search behavior. |
| agent-loop-instance-state | apps/api/src/modules/agents/agent-loop-instance-state.ts | 2026-07 PMO-flow UX（§6-2）：instance 忙闲变化发 SSE（agent.instance.status_changed）。 |
| agent-loop-prompts | apps/api/src/modules/agents/agent-loop-prompts.ts | §10 P0: 注入总预算（skill 段 + 知识段共用的 2K 红线）。 |
| agent-loop-record-result | apps/api/src/modules/agents/agent-loop-record-result.ts | 2026-07 PMO-flow UX（§6-3）：里程碑消息 meta 的归属 PMO 解析。 |
| agent-loop-session | apps/api/src/modules/agents/agent-loop-session.ts | 首 step（新建会话）执行失败时重置 sessionId：CLI 会话未必已建立（可能根本没 spawn 到）， |
| agent-loop-step-guards | apps/api/src/modules/agents/agent-loop-step-guards.ts | AgentLoop agentStep 前置守卫（B2 测试特征 WU 关闭 / C3 每日 token 预算熔断）—— |
| agent-loop-utils | apps/api/src/modules/agents/agent-loop-utils.ts | AgentLoop 进程/git 小工具 —— 从 agent-loop.ts 原样抽出，行为不变。 |
| agent-loop-workspace | apps/api/src/modules/agents/agent-loop-workspace.ts | B3a 归属链：执行根目录解析 — metadata.workspaceRoot 优先（Requirement→PMO gitRepo / 人工回复绑定的直接路径），否则按 wu.workspaceId 查 workspace 记录（F6 旧路径）。 |
| agent-output-parser | apps/api/src/modules/agents/agent-output-parser.ts | P0 修复（reviewReport 回传断链）：解析 reviewer 最终输出为结构化审查结论。 |
| agent-targeting | apps/api/src/modules/agents/agent-targeting.ts | AgentLoop 观察→目标解析（纯代码，零 LLM）—— 从 agent-loop.ts 原样抽出，行为不变。 |
| workunit-token-events | apps/api/src/modules/agents/workunit-token-events.ts | 非缓存执行 tokens（CLI usage input+output，不含 cache）。CLI 未回报 usage 时传 null —— |
| wu-test-guards | apps/api/src/modules/agents/wu-test-guards.ts | B2 测试特征 WU 守卫（2026-08-03 token-burn issue P0-1c）—— 从 agent-loop.ts 原样抽出，行为不变。 |
| conversation-extraction | apps/api/src/modules/knowledge/conversation-extraction.ts | conversation-extraction — R3 会话提取 + 提案审核闭环 |
| inject-context | apps/api/src/modules/knowledge/inject-context.ts | inject-context — injectContext 的注入闸门与 2K 预算 helpers |
| knowledge-data-layer | apps/api/src/modules/knowledge/knowledge-data-layer.ts | knowledge-data-layer — KnowledgeService 的数据层（文件系统存取） |
| knowledge-forms | apps/api/src/modules/knowledge/knowledge-forms.ts | knowledge-forms — 知识形态门禁（form validation gate） |
| knowledge-metrics | apps/api/src/modules/knowledge/knowledge-metrics.ts | knowledge-metrics — 飞轮/审计的事件流度量（R1/M1） |
| knowledge-search-helpers | apps/api/src/modules/knowledge/knowledge-search-helpers.ts | knowledge-search-helpers — 关键词检索与 RAG 降级 helpers |
| knowledge-types | apps/api/src/modules/knowledge/knowledge-types.ts | knowledge-types — KnowledgeService 的 Studio 侧类型与类型映射 |
| okr-metric-queries | apps/api/src/modules/pmo/okr-metric-queries.ts | OKR metric 查询基类（B8 数据源查询层） |
| workunit-crud | apps/api/src/modules/workunit/workunit-crud.ts | WorkUnit CRUD + Claim 持久化层 —— WorkUnitService 的基类（自 workunit.service.ts 拆分，纯代码移动）。 |
| okrUtils | apps/web/src/components/pmo/okrUtils.ts | OKR 度量工具 — 当前季度 / metricType 选项与元数据 / KR 目标校验（从 pages/PMOPage.tsx 抽出，纯代码移动） |
