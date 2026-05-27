# CAPABILITIES.md

> 最后更新: 2026-05-26

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
| company-skill.service.test | packages/studio-capability/src/services/company-skill.service.test.ts | CompanySkillService 单元测试 |
| company-skill.service | packages/studio-capability/src/services/company-skill.service.ts | ⚠️ DEPRECATED: 公司技能库服务 |
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
| knowledge-keeper | packages/studio-shared/src/harness/wiki/knowledge-keeper.ts | Knowledge Keeper — 知识库守护者（统一角色入口） |
| knowledge-query | packages/studio-shared/src/harness/wiki/knowledge-query.ts | Knowledge Keeper 查询 — 搜索公司 Wiki 知识库 |
| wiki-service | packages/studio-shared/src/harness/wiki/wiki-service.ts | Wiki Service — 公司知识库的 Markdown 页面读写 |
| llm-client | packages/studio-shared/src/llm/llm-client.ts | LLM 客户端 |
| model-gateway | packages/studio-shared/src/llm/model-gateway.ts | Model Gateway - 统一 LLM 调用网关 |
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
| change-approver.service.test | packages/studio-spec/src/services/change-approver.service.test.ts | ChangeApproverService 单元测试 |
| change-approver.service | packages/studio-spec/src/services/change-approver.service.ts | 变更审批服务 |
| change-history.service.test | packages/studio-spec/src/services/change-history.service.test.ts | ChangeHistoryService 单元测试 |
| change-history.service | packages/studio-spec/src/services/change-history.service.ts | 变更历史服务 |
| gate-checker.service.test | packages/studio-spec/src/services/gate-checker.service.test.ts | GateCheckerService 单元测试 |
| gate-checker.service | packages/studio-spec/src/services/gate-checker.service.ts | 门禁检查服务 |
| spec-bypass.service | packages/studio-spec/src/services/spec-bypass.service.ts | Spec 绕过审批服务 |
| spec-validator.service.test | packages/studio-spec/src/services/spec-validator.service.test.ts | SpecValidator 单元测试 |
| spec-validator.service | packages/studio-spec/src/services/spec-validator.service.ts | SpecValidator 主服务 |
| spec-version.service | packages/studio-spec/src/services/spec-version.service.ts | Spec 版本管理服务 |
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
| agent-context | apps/api/src/modules/agents/agent-context.ts | buildAgentContext — 统一 Agent 上下文构建器 |
| agent-router | apps/api/src/modules/agents/agent-router.ts | AgentRouter - Layer 2 of three-layer Agent architecture (§12.10) |
| auditor-agent.service | apps/api/src/modules/agents/auditor-agent.service.ts | Auditor Agent — 跨任务审计 + 周期洞察 |
| deploy-agent.service | apps/api/src/modules/agents/deploy-agent.service.ts | Deploy Agent — merge to master, push, deploy, cleanup |
| knowledge-agent.service | apps/api/src/modules/agents/knowledge-agent.service.ts | Knowledge Agent - 从执行结果中异步提取知识 |
| monitor-agent.service | apps/api/src/modules/agents/monitor-agent.service.ts | Monitor Agent - 健康监控 + 渐进告警 + G31 知识沉淀闸门(precipitate→TTL) |
| ops-agent.service | apps/api/src/modules/agents/ops-agent.service.ts | Ops Agent — 系统生命周期守护 |
| ops-rules | apps/api/src/modules/agents/ops-rules.ts | Ops Rules — 运行时数据，不在代码里 |
| post-eval-agent.service | apps/api/src/modules/agents/post-eval-agent.service.ts | PostEval Agent — 交付完整性审计 (2026-05-21) |
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
| analyst-trigger.service | apps/api/src/modules/channels/analyst-trigger.service.ts | Q7: 按 `## ` 标题分割知识文档，选取与需求关键词匹配的段落 |
| channel-init | apps/api/src/modules/channels/channel-init.ts | Seed default channels on startup (B1-001) |
| channel-message.service | apps/api/src/modules/channels/channel-message.service.ts | ChannelMessage Service — centralized message creation + event publishing |
| channel.routes | apps/api/src/modules/channels/channel.routes.ts | Channel Routes — B1-001/B1-002/B1-009/B1-011 |
| discovery-exposure.service | apps/api/src/modules/channels/discovery-exposure.service.ts | Discovery Exposure Service — G33 Analyst+Reviewer 发现→#系统 channel |
| requirements-doc.routes | apps/api/src/modules/channels/requirements-doc.routes.ts | RequirementsDoc edit routes — B2-009 |
| routes | apps/api/src/modules/companies/routes.ts | Company API 路由 |
| routes | apps/api/src/modules/dingtalk/routes.ts | 钉钉机器人交互回调 |
| command-runner | apps/api/src/modules/discord/command-runner.ts | B3-002/B3-003: Shared command runner for CLI and Discord |
| routes | apps/api/src/modules/discord/routes.ts | Discord Interactions Endpoint |
| routes | apps/api/src/modules/environments/routes.ts | environments/routes.ts — Environment Manager CRUD (HZ-023) |
| event.routes | apps/api/src/modules/events/event.routes.ts | G30: StudioEvent API Endpoints |
| sse.routes | apps/api/src/modules/events/sse.routes.ts | HZ-028: Event Stream (SSE) |
| routes | apps/api/src/modules/executions/routes.ts | Execution API 路由 |
| agent-event-listener | apps/api/src/modules/goals/agent-event-listener.ts | Agent Event Listener - 监听 AgentExecutor 的 Redis 事件 |
| goal-scheduler | apps/api/src/modules/goals/goal-scheduler.ts | Goal Scheduler - 轮询 executing 状态的 Goal，调度可执行的 step |
| goal.service | apps/api/src/modules/goals/goal.service.ts | Goal Service - Goal 驱动架构核心 |
| routes | apps/api/src/modules/goals/routes.ts | Goal API 路由 - Goal 驱动架构 |
| evolution.service | apps/api/src/modules/harness/evolution.service.ts | Constraint Evolution Service — 约束规则进化 |
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
| client | apps/api/src/modules/llm/client.ts | LLM 客户端 - 支持 OpenAI 兼容 API |
| config.routes | apps/api/src/modules/llm/config.routes.ts | LLM Config API 路由 |
| config.service | apps/api/src/modules/llm/config.service.ts | LLM Config Service - 加密存储 + 分层配置解析 |
| creation-analyzer | apps/api/src/modules/llm/creation-analyzer.ts | 创建意图分析器 - 从自然语言生成 Skill/Workflow 配置 |
| intent-analyzer | apps/api/src/modules/llm/intent-analyzer.ts | LLM 意图分析器 - 使用 /api/v1/llm/chat（统一使用 Studio LLM 配置） |
| proxy | apps/api/src/modules/llm/proxy.ts | 获取 LLM 配置 |
| admin.routes | apps/api/src/modules/mcp/admin.routes.ts | MCP Admin Routes — tool management, permissions, audit |
| permission.service | apps/api/src/modules/mcp/permission.service.ts | MCP Permission Service — role×tool access control + audit logging |
| routes | apps/api/src/modules/mcp/routes.ts | MCP HTTP Routes |
| server | apps/api/src/modules/mcp/server.ts | MCP Server - Model Context Protocol 服务器 |
| tool-registry | apps/api/src/modules/mcp/tool-registry.ts | MCP Tool Registry — dynamic registration, health, rate limiting |
| tools | apps/api/src/modules/mcp/tools.ts | MCP Tools 定义 |
| init-trace | apps/api/src/modules/monitoring/init-trace.ts | ⑨: Trace pipeline initialization |
| trace-pipeline.service | apps/api/src/modules/monitoring/trace-pipeline.service.ts | TracePipelineService — ⑨ 修复 |
| routes | apps/api/src/modules/notifications/routes.ts | 通知 API 路由 |
| notify.service | apps/api/src/modules/outbound-notify/notify.service.ts | NotifyService - 通知服务 |
| routes | apps/api/src/modules/outbound-notify/routes.ts | Notify API 路由 |
| routes | apps/api/src/modules/outputs/routes.ts | 产出文档 API - 存储和展示执行结果 |
| pipeline-dashboard.routes | apps/api/src/modules/pipeline-dashboard/pipeline-dashboard.routes.ts | Dogfood Status Dashboard — GET /api/v1/dogfood/status |
| okr.service | apps/api/src/modules/pmo/okr.service.ts | 🆕 AS-016: 获取当前季度 |
| project.service | apps/api/src/modules/pmo/project.service.ts | Project Service - PMO 项目管理 |
| routes | apps/api/src/modules/pmo/routes.ts | GET /api/v1/pmo/project |
| memory-routes | apps/api/src/modules/roles/memory-routes.ts | Role Memory API 路由 |
| memory.service | apps/api/src/modules/roles/memory.service.ts | MemoryService - 角色记忆管理 |
| role-config.service | apps/api/src/modules/roles/role-config.service.ts | RoleConfig Service — 可进化角色配置的 CRUD + 初始化 |
| role.service | apps/api/src/modules/roles/role.service.ts | Role Service — 角色管理 |
| role.types | apps/api/src/modules/roles/role.types.ts | Role memory types — used by memory.service.ts |
| routes | apps/api/src/modules/roles/routes.ts | Role API 路由 |
| routes | apps/api/src/modules/runtime-config/routes.ts | GET /api/v1/runtime-config |
| routes | apps/api/src/modules/skills/routes.ts | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| routes | apps/api/src/modules/spec-reviews/routes.ts | Spec 审查 API 路由 |
| spec-review.service | apps/api/src/modules/spec-reviews/spec-review.service.ts | Spec 审查服务 |
| routes | apps/api/src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| routes | apps/api/src/modules/tools-std/routes.ts | skills/routes.ts - Tool 管理 API（tools/std 目录） |
| skill-extraction.service | apps/api/src/modules/tools-std/skill-extraction.service.ts | Skill Extraction Service — 面向新架构 GoalExecution |
| skill-proposal-routes | apps/api/src/modules/tools-std/skill-proposal-routes.ts | Skill Proposal API 路由 |
| error-class | apps/api/src/modules/triage/error-class.ts | Triage ErrorClass — B1-007: 八类错误标签 + 严重度三级 + 策略路由 |
| wiki.routes | apps/api/src/modules/wiki/wiki.routes.ts | GET /api/v1/wiki |
| channel | apps/web/src/api/channel.ts | Channel API — B1-001 |
| examples | apps/web/src/data/examples.ts | 预置示例工作流 |
| useCapabilities | apps/web/src/hooks/useCapabilities.ts | 获取 Stage 分类数据（UI-001） |
| useChannelEvents | apps/web/src/hooks/useChannelEvents.ts | Channel SSE hook — B2: EventSource 实时推送替代 3s 轮询 |
| useCompanyId | apps/web/src/hooks/useCompanyId.ts | useCompanyId - 统一获取公司 ID |
| useCompanyStats | apps/web/src/hooks/useCompanyStats.ts | useCompanyStats - 公司大厅统计数据 Hook |
| useDashboardData | apps/web/src/hooks/useDashboardData.ts | useDashboardData - 首页聚合数据 Hook（优化首屏加载） |
| useGlobalModals | apps/web/src/hooks/useGlobalModals.ts | 全局弹窗状态 hook |
| useWebSocket | apps/web/src/hooks/useWebSocket.ts | WebSocket 连接管理 Hook（P2-4） |
| useWebSocketHandlers | apps/web/src/hooks/useWebSocketHandlers.ts | WebSocket 事件处理 hook |
| agentStore | apps/web/src/stores/agentStore.ts | agentStore |
| authStore | apps/web/src/stores/authStore.ts | 认证状态管理 - Auth Store (Zustand) |
| goalStore | apps/web/src/stores/goalStore.ts | goalStore |
| runtimeStore | apps/web/src/stores/runtimeStore.ts | runtimeStore |
| stepEditorStore | apps/web/src/stores/stepEditorStore.ts | stepEditorStore.ts - Step 编辑器状态管理 |
| uiStore | apps/web/src/stores/uiStore.ts | uiStore |
| setup | apps/web/src/test/setup.ts | setup |
| canvas | apps/web/src/types/canvas.ts | 共享画布类型（xyflow 兼容，避免直接导入 xyflow 打包） |
| types | apps/web/src/types.ts | types.ts - Agent Studio 类型定义 |
| api | apps/web/src/utils/api.ts | 获取 API 基础 URL |
| format | apps/web/src/utils/format.ts | 格式化 Token 数量 |
| generateDirectoryName | apps/web/src/utils/generateDirectoryName.ts | 根据项目名称生成目录名称 |
| slugify | apps/web/src/utils/slugify.ts | 将字符串转换为 URL 友好的 slug |
| status-utils | apps/web/src/utils/status-utils.ts | Unified status / role / stance utilities. |
| toast | apps/web/src/utils/toast.ts | Lightweight toast notification system (zero dependencies) |
