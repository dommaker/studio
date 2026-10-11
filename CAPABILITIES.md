# CAPABILITIES.md

> 最后更新: 2026-10-11

---

| 模块 | 文件 | 说明 |
|------|------|------|
| src | packages/studio-agent/src/ | studio-agent 类型定义 |
| levels | packages/studio-shared/src/constants/levels.ts | 级别配置 - 全局统一的职级定义 |
| src | packages/studio-shared/src/ | Studio Event Bus — 替代 Redis pub/sub（2026-05-08） |
| auditor-types | packages/studio-shared/src/harness/auditor/auditor-types.ts | Auditor ↔ 其他角色协议定义（BP-013 + BP-014） |
| harness | packages/studio-shared/src/harness/ | Constraint Prompt Injection — 将 harness 约束的前置声明注入 Agent prompt |
| runtime | packages/studio-shared/src/harness/runtime/ | Harness Runtime Bootstrap — Phase 2 迁移 |
| agents | apps/api/src/modules/agents/ | SystemExecutor — 系统级 LLM 调用抽象，替代 modelGateway |
| types | packages/studio-shared/src/types/ | Goal 状态类型 — SQLite 不支持 enum，用 TypeScript 类型守卫约束 |
| utils | packages/studio-shared/src/utils/ | Shared Logger - 统一日志接口 |
| src | packages/studio-skill/src/ | SkillLoader — 按 trigger 加载 Skill，注入 Agent prompt |
| docs-freshness.routes | apps/api/src/modules/admin/docs-freshness.routes.ts | T-020 + T-059: CLAUDE.md + CAPABILITIES.md Freshness Check |
| routes | apps/api/src/modules/audit-logs/routes.ts | GET /api/audit-logs - 查询审计日志 |
| auth | apps/api/src/modules/auth/ | POST /api/v1/auth/guest-session |
| channels | apps/api/src/modules/channels/ | Seed default channels on startup (B1-001) |
| companies | apps/api/src/modules/companies/ | Company API 路由 — 存储迁移 Prisma → FileStore |
| discord | apps/api/src/modules/discord/ | B3-002/B3-003: Shared command runner for CLI and Discord |
| events | apps/api/src/modules/events/ | G30: StudioEvent API Endpoints |
| harness | apps/api/src/modules/harness/ | Iron Laws API — 从 runtime-proxy 迁移 (2026-05-14) |
| knowledge | apps/api/src/modules/knowledge/ | DecisionChainExtractor (G-004) — 从 Meeting 辩论 + Goal 执行中提取决策链 |
| mcp | apps/api/src/modules/mcp/ | MCP Admin Routes — tool management, permissions, audit |
| routes | apps/api/src/modules/notifications/routes.ts | 通知 API 路由 |
| pmo | apps/api/src/modules/pmo/ | 🆕 AS-016: 获取当前季度 |
| skills | apps/api/src/modules/skills/ | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| routes | apps/api/src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| action-center | packages/studio-contract/src/action-center.ts | action-center 域契约——正本以 apps/api/src/modules/action-center/ |
| admin | packages/studio-contract/src/admin.ts | admin 域契约（批次 6/7）——正本以 apps/api/src/modules/admin/ |
| agent-profiles | packages/studio-contract/src/agent-profiles.ts | agent-profiles / agent-instances 域契约（批次 8/8）——实体类型与 studio-shared |
| agents | packages/studio-contract/src/agents.ts | agents 域契约——§10.5 token-usage 面（/api/v1/agents 下唯一活面）。 |
| audit-logs | packages/studio-contract/src/audit-logs.ts | audit-logs 域契约（批次 6/7）——正本以 apps/api/src/modules/audit-logs/ |
| auth | packages/studio-contract/src/auth.ts | auth 域契约（批次 6/7；敏感域）——本文件 schema 即 wire 正本（#685 归一： |
| channels | packages/studio-contract/src/channels.ts | channels 域契约——正本字段以 apps/api/src/modules/channels/channel.service.ts |
| companies | packages/studio-contract/src/companies.ts | companies 域契约——正本字段以 apps/api/src/modules/companies/routes.ts 实际 wire 行为为准 |
| cso | packages/studio-contract/src/cso.ts | cso 域契约（批次 6/7）——正本以 apps/api/src/modules/harness/cso.routes.ts |
| deploy | packages/studio-contract/src/deploy.ts | deploy 域契约（批次 7/8）——**协议面例外，只做形状声明，路由保持原样**。 |
| discord | packages/studio-contract/src/discord.ts | discord 域契约（批次 7/8）——**协议面例外，只做形状声明，路由保持原样**。 |
| envelope | packages/studio-contract/src/envelope.ts | 统一响应壳（target-architecture.md §契约）： |
| events | packages/studio-contract/src/events.ts | events 域契约——正本以 apps/api/src/modules/events/event.routes.ts 与 |
| evolution | packages/studio-contract/src/evolution.ts | evolution 域契约——实体 EvolutionProposal 与 studio-shared file-store-types |
| harness | packages/studio-contract/src/harness.ts | harness 域契约（批次 6/7）——正本以 apps/api/src/modules/harness/ |
| iron-laws | packages/studio-contract/src/iron-laws.ts | iron-laws 域契约（批次 6/7）——正本以 apps/api/src/modules/harness/ |
| knowledge | packages/studio-contract/src/knowledge.ts | knowledge 域契约——正本字段以 apps/api/src/modules/knowledge/ 实测 wire 为准： |
| library | packages/studio-contract/src/library.ts | library 域契约——正本以 apps/api/src/modules/library/library.service.ts |
| mcp | packages/studio-contract/src/mcp.ts | mcp 域契约（批次 7/8）——正本以 apps/api/src/modules/mcp/ 的 REST 管理面 |
| monitoring | packages/studio-contract/src/monitoring.ts | monitoring 域契约——schema 即 wire 正本（#685 Phase 1：手写 interface 归一为 |
| notifications | packages/studio-contract/src/notifications.ts | notifications 域契约——正本以 packages/studio-notification |
| notify-channels | packages/studio-contract/src/notify-channels.ts | notify-channels 域契约——正本以 apps/api/src/modules/notifications/channels/ |
| outbound-notify | packages/studio-contract/src/outbound-notify.ts | outbound-notify 域契约——正本以 apps/api/src/modules/notifications/ 的 |
| pmo | packages/studio-contract/src/pmo.ts | pmo 域契约——正本字段以 apps/api/src/modules/pmo/project.service.ts（ProjectData）、 |
| projects | packages/studio-contract/src/projects.ts | projects 域契约——正本字段以 apps/api/src/modules/projects/project-discovery.service.ts |
| requirements | packages/studio-contract/src/requirements.ts | requirements 域契约——正本字段以 apps/api/src/modules/requirements/requirement.service.ts |
| review-proposals | packages/studio-contract/src/review-proposals.ts | review-proposal 域契约——正本以 apps/api/src/modules/review-proposal/ |
| skills | packages/studio-contract/src/skills.ts | skills 域契约——正本字段以 apps/api/src/modules/skills/skill-store.ts（SkillRecord）、 |
| specs | packages/studio-contract/src/specs.ts | specs 域契约——字段正本在 apps/api/src/modules/specs 的 types/change.types.ts |
| sse-events | packages/studio-contract/src/sse-events.ts | SSE 事件负载契约（#665，ADR 2026-08-24 D1/D2 落地）——/api/v1/events/stream |
| transcripts | packages/studio-contract/src/transcripts.ts | transcripts 域契约——正本以 apps/api/src/modules/transcripts/ |
| triggers | packages/studio-contract/src/triggers.ts | triggers 域契约——正本字段以 apps/api/src/modules/triggers/trigger.types.ts |
| type-assert | packages/studio-contract/src/type-assert.ts | 编译期互锚工具（#685）：schema 推型与源类型互相 extends 才通过， |
| workspaces | packages/studio-contract/src/workspaces.ts | workspaces 域契约——正本字段以 apps/api/src/modules/workspaces/local-workspace.ts |
| workunit | packages/studio-contract/src/workunit.ts | workunit 域契约（首个迁移域，30+ 域的模板）——正本字段以 |
| monitoring | packages/studio-shared/src/constants/monitoring.ts | 监控探针阈值（#181 决策 #62 D2/D3 + #167③）--api 探针与 Web 下钻口径同源（#209 smell 3）。 |
| agent-loop | apps/api/src/bootstrap/agent-loop.ts | ── AS-026: AgentLoop per AgentProfile ── |
| channels | apps/api/src/bootstrap/channels.ts | ── Channel 初始化（Goal 管线需要）── |
| auditor-execution | apps/api/src/modules/agent-auditor/auditor-execution.ts | Auditor Agent — 建议执行 / 升级 / 闭环 |
| auditor-reports | apps/api/src/modules/agent-auditor/auditor-reports.ts | Auditor Agent — 洞察与报告输出 |
| auditor-rules | apps/api/src/modules/agent-auditor/auditor-rules.ts | Auditor Agent — 审计规则（检测 → 建议） |
| auditor.service | apps/api/src/modules/agent-auditor/auditor.service.ts | Auditor Service — 跨任务审计 + 周期洞察 |
| review-adapter | apps/api/src/modules/agent-auditor/review-adapter.ts | review-adapter (#356) — auditor_suggestion 提案卡 adapter（接线 review-proposal 正本） |
| knowledge-cold-start | apps/api/src/modules/agent-knowledge/knowledge-cold-start.ts | Knowledge Agent — 冷启动子模块 |
| knowledge-curator.service | apps/api/src/modules/agent-knowledge/knowledge-curator.service.ts | Knowledge Curator - 知识库冷启动与每日维护 |
| knowledge-extraction | apps/api/src/modules/agent-knowledge/knowledge-extraction.ts | Knowledge Agent — 提取 prompt 单一来源 |
| knowledge-maintenance | apps/api/src/modules/agent-knowledge/knowledge-maintenance.ts | Knowledge Agent — 语料分析（每日维护）子模块 |
| agent-loop-events | apps/api/src/modules/agent-loop/agent-loop-events.ts | 非缓存执行 tokens（CLI usage input+output，不含 cache）。CLI 未回报 usage 时传 null —— |
| agent-loop-guards | apps/api/src/modules/agent-loop/agent-loop-guards.ts | AgentLoop 守卫函数区（2026-08 工单 28 从 agent-loop.ts 原样抽出，行为不变）： |
| agent-loop-parsers | apps/api/src/modules/agent-loop/agent-loop-parsers.ts | #467：解析 NEED_INPUT 后续的 RULING: JSON 行（plan 裁决轮契约，见 prompt-composer |
| agent-loop-registry | apps/api/src/modules/agent-loop/agent-loop-registry.ts | #634: provider 变更重挂入口——同一 profile 的多次变更串行排队（上一环失败不阻塞后续）， |
| agent-loop | apps/api/src/modules/agent-loop/agent-loop.ts | AgentLoop — observe→resolveTarget→agentStep→recordResult decision loop (AS-025) |
| agent-loop.types | apps/api/src/modules/agent-loop/agent-loop.types.ts | AgentLoop 类型契约（2026-08 工单 28 从 agent-loop.ts 原样抽出，行为不变）： |
| claim-fitness | apps/api/src/modules/agent-loop/claim-fitness.ts | 认领前适任判断（决策 14，docs/adr/2026-08-25-review-independence-trust-model.md 补充段）。 |
| completion-gates | apps/api/src/modules/agent-loop/completion-gates.ts | 收口守卫链（2026-08 从 agent-loop.recordResult 抽出，行为一字不改）： |
| completion-harvest | apps/api/src/modules/agent-loop/completion-harvest.ts | per-WU-type COMPLETE 收割注册表（#542，2026-09-15 架构评审候选 A2） |
| context-overflow | apps/api/src/modules/agent-loop/context-overflow.ts | #96: CLI 上下文溢出纯反应式策略 —— 溢出错误识别 + 会话滚动摘要构建（纯函数，零服务依赖）。 |
| daily-token-budget | apps/api/src/modules/agent-loop/daily-token-budget.ts | C3（2026-08-03 unattended-token-burn issue P2-2，决策记录 #4）：每日 token 预算熔断。 |
| delegate-branch | apps/api/src/modules/agent-loop/delegate-branch.ts | A2A §4.1 DELEGATE 分支（2026-08 从 agent-loop.recordResult 抽出，行为一字不改）： |
| dispatch-reconciliation | apps/api/src/modules/agent-loop/dispatch-reconciliation.ts | #183 派工/评审断链 5min 对账扫描（dispatch-reconciliation-scan handler 本体）。 |
| execution-cwd | apps/api/src/modules/agent-loop/execution-cwd.ts | 执行目录解析段（#668 自 agent-loop.ts 抽出，行为一字不改）： |
| execution-step-events | apps/api/src/modules/agent-loop/execution-step-events.ts | 执行步事件（WU 过程可视化） |
| executor | apps/api/src/modules/agent-loop/executor.ts | §9.6 Executor 接口 — AgentLoop 执行面抽象（P0） |
| lease-heartbeat | apps/api/src/modules/agent-loop/lease-heartbeat.ts | #178（2026-08-16，#63 决议 1/2）WU 租约心跳。 |
| loop-claim | apps/api/src/modules/agent-loop/loop-claim.ts | 认领段（#668 自 agent-loop.ts 抽出，行为一字不改）： |
| loop-host | apps/api/src/modules/agent-loop/loop-host.ts | AgentLoop 段间宿主契约（#668 agent-loop.ts 按职责切深模块）。 |
| loop-lifecycle | apps/api/src/modules/agent-loop/loop-lifecycle.ts | 生命周期段（#668 自 agent-loop.ts 抽出，行为一字不改）： |
| loop-observe | apps/api/src/modules/agent-loop/loop-observe.ts | 观察段（#668 自 agent-loop.ts 抽出，行为一字不改）： |
| loop-record-result | apps/api/src/modules/agent-loop/loop-record-result.ts | 结果记录段（#668 自 agent-loop.ts 抽出，行为一字不改）： |
| loop-step | apps/api/src/modules/agent-loop/loop-step.ts | 步执行段（#668 自 agent-loop.ts 抽出，行为一字不改）： |
| prompt-composer | apps/api/src/modules/agent-loop/prompt-composer.ts | prompt/上下文组装编排（2026-08 从 agent-loop.agentStep 抽出；#671 按组装段拆分）： |
| prompt-quota | apps/api/src/modules/agent-loop/prompt-quota.ts | prompt 注入段定额与截断共享件（#671 自 prompt-composer.ts 拆出）： |
| prompt-section-contract | apps/api/src/modules/agent-loop/prompt-section-contract.ts | contract 段（#671 自 prompt-composer.ts 拆出）：`## 产出契约` 段模板正本 + 组装。 |
| prompt-section-files | apps/api/src/modules/agent-loop/prompt-section-files.ts | files 段（#671 自 prompt-composer.ts 拆出）：`## 引用文件` 段组装。 |
| prompt-section-handoff | apps/api/src/modules/agent-loop/prompt-section-handoff.ts | handoff 段（#671 自 prompt-composer.ts 拆出）：`## 前序进展` 段组装。 |
| prompt-section-map | apps/api/src/modules/agent-loop/prompt-section-map.ts | map 段（#671 自 prompt-composer.ts 拆出）：`## PMO 地图` 段组装。 |
| prompt-section-memory | apps/api/src/modules/agent-loop/prompt-section-memory.ts | memory 段（#671 自 prompt-composer.ts 拆出）：`## 角色记忆索引` 段组装。 |
| prompt-section-persona | apps/api/src/modules/agent-loop/prompt-section-persona.ts | persona 段（#671 自 prompt-composer.ts 拆出）：`## 你的角色` 段组装。 |
| prompt-section-roster | apps/api/src/modules/agent-loop/prompt-section-roster.ts | roster 段（#671 自 prompt-composer.ts 拆出）：`## 频道成员与委派` 段组装。 |
| prompt-section-skill | apps/api/src/modules/agent-loop/prompt-section-skill.ts | skills 段（#671 自 prompt-composer.ts 拆出）：`## 本次任务 Skills` 段组装。 |
| result-bookkeeping | apps/api/src/modules/agent-loop/result-bookkeeping.ts | recordResult 簿记段（#655 从 agent-loop.recordResult 抽出，行为一字不改）： |
| review-contract | apps/api/src/modules/agent-loop/review-contract.ts | Review Contract — 审查结论（verdict）语义的单一来源 |
| review-dispatcher | apps/api/src/modules/agent-loop/review-dispatcher.ts | ReviewDispatcher - AC-4.1 ~ AC-4.5: 状态机驱动的 review 系统代派 |
| session-resume | apps/api/src/modules/agent-loop/session-resume.ts | #94 会话续用判定（会话号 per-WU 化）：纯函数，零服务依赖。 |
| step-guards | apps/api/src/modules/agent-loop/step-guards.ts | 入口守卫链（#541，2026-09 从 agent-loop.agentStep 头部原样抽出，行为一字不改， |
| step-retry-policy | apps/api/src/modules/agent-loop/step-retry-policy.ts | 步执行重试策略（#543，2026-09 架构评审 A3）：收编 agentStep 中段两段孪生重试骨架 —— |
| wu-lease | apps/api/src/modules/agent-loop/wu-lease.ts | #209 smell 4（源自 #178 / #63 决议 1/2）：WU 租约追踪器。 |
| wu-verification | apps/api/src/modules/agent-loop/wu-verification.ts | B3b-i（决策 D3 前半）WU 自动验证 —— 从 agent-loop 抽出的可复用实现（2026-07-30 F6-c 断链修复）。 |
| review-adapter | apps/api/src/modules/evolution/review-adapter.ts | review-adapter (#623) — evolution 人审提案 adapter（接线 review-proposal 正本） |
| review-adapter | apps/api/src/modules/knowledge/review-adapter.ts | review-adapter (#355) — knowledge 提案审批 adapter（接线 review-proposal 正本） |
| review-adapter | apps/api/src/modules/role-memory/review-adapter.ts | review-adapter (#353) — role-memory 人审提案 adapter（接线 review-proposal 正本） |
| review-adapter | apps/api/src/modules/skills/review-adapter.ts | review-adapter (#354) — skills 提案审批 adapter（接线 review-proposal 正本） |
| auth | apps/web/src/api/auth.ts | Auth API - 认证系统（P3-a 自 api/index.ts 拆出） |
| events | apps/web/src/api/events.ts | Events API — #180 事件检索（#60 决策 Q3a：GET /events 过滤 + 尾部倒读游标分页） |
| evolution | apps/web/src/api/evolution.ts | Evolution proposal review API — #623 断点 3 遗留补丁（review-proposal 正本 kind='evolution'） |
| harness | apps/web/src/api/harness.ts | Harness API — /harness/*（T-015 Harness 监控集成，admin 中间件） |
| knowledge | apps/web/src/api/knowledge.ts | Knowledge API — 知识审核闭环 + 知识库浏览： |
| library | apps/web/src/api/library.ts | Library API (#155 T5: 阅览室——跨项目 .studio/ 聚合只读层；无写路径) |
| monitoring | apps/web/src/api/monitoring.ts | Monitoring API — Agent Network (MVP-2 + MVP-6) |
| pmo | apps/web/src/api/pmo.ts | PMO API — /pmo/project（projectApi，P3-a 自 api/index.ts 归位）+ /pmo/okr（okrApi： |
| projects | apps/web/src/api/projects.ts | Projects API — #266（决策 #258）：工程发现候选 + 归属候选排除清单管理 |
| requirements | apps/web/src/api/requirements.ts | Requirement API — REQ 需求编号体系（vision §5.3） |
| skills | apps/web/src/api/skills.ts | Skills API — #278（决策 #250 D2）：retract_confirm 卡退役决策 |
| workspaces | apps/web/src/api/workspaces.ts | Workspace API — AS-020 P2/P7（P3-a 自 api/index.ts 拆出） |
| workunit | apps/web/src/api/workunit.ts | 从 GET /events?type=workunit:tokens 的响应行中解析某个 WorkUnit 的 token 事件。 |
| Sidebar | apps/web/src/components/Sidebar.tsx | Sidebar.tsx - 全局侧边栏组件（#693 自 SidebarNew.tsx 正名，New 后缀退役） |
| AutocompletePopup | apps/web/src/components/channel/AutocompletePopup.tsx | AutocompletePopup（#691，docs/plans/2026-10-arch-simplification.md Phase 2-2）： |
| FileRefChips | apps/web/src/components/channel/FileRefChips.tsx | FileRefChips（#691 自 ChannelInput 抽出）：#485 文件引用台账可视化——chip 可单独移除 |
| MergePreviewBar | apps/web/src/components/channel/MergePreviewBar.tsx | MergePreviewBar（#691 自 ChannelInput 抽出）：#632 发送前归属预览条（复用 reply 预览条 |
| channelAutocompleteGroups | apps/web/src/components/channel/channelAutocompleteGroups.tsx | channelAutocompleteGroups（#691 自 ChannelInput 抽出）：@/# 两弹框的候选分组构建器—— |
| SettingsPage | apps/web/src/pages/SettingsPage.tsx | 设置页面 — #434 死配置清理 + #481「默认执行机器」退役后的活节（工程候选 / 通知渠道 #525 / 主题），全部组件内即时保存，无保存栏 |
| types | packages/studio-agent/src/services/types.ts | Executor 公共类型 |
| types | packages/studio-skill/src/types.ts | Skill 定义类型 |
| current-wu-context | apps/api/src/modules/ops/current-wu-context.ts | 当前 WU 聚合上下文（2026-07 PMO-flow UX §6-1；#318 自 monitoring.service 提取为共享出口）： |
| instance-timeout-scan | apps/api/src/modules/ops/instance-timeout-scan.ts | #179（#66 决议 3 scan 侧）agent-timeout-scan handler 本体。 |
| lock-events-bridge | apps/api/src/modules/ops/lock-events-bridge.ts | lock.* 事件 → Monitor 告警桥（#169 / #64 决议 4；#687 自 events 模块迁入—— |
| metrics-aggregate | apps/api/src/modules/ops/metrics-aggregate.ts | D16 聚合核心纯函数（工单 30 自 metrics.service.ts 纯函数区抽出，纯搬运零逻辑变更）： |
| metrics.service | apps/api/src/modules/ops/metrics.service.ts | D16 监控指标聚合（B5）— 任务流健康 / 入口转化 / 人工干预 / 周期 / 角色 / 工程质量 / Token / 告警。 |
| metrics.types | apps/api/src/modules/ops/metrics.types.ts | D16 监控指标类型契约（工单 30 自 metrics.service.ts 类型区抽出，纯搬运零逻辑变更）： |
| monitor-alerts | apps/api/src/modules/ops/monitor-alerts.ts | Monitor Agent — 告警分发 / Triage 升级 / 事件写入 |
| monitor-lifecycle | apps/api/src/modules/ops/monitor-lifecycle.ts | Monitor Agent — G31 数据生命周期：知识沉淀闸门 + TTL 清理 |
| monitor-probes | apps/api/src/modules/ops/monitor-probes.ts | Monitor Agent — 任务/WorkUnit 级探测 |
| monitor-reports | apps/api/src/modules/ops/monitor-reports.ts | Monitor Agent — 报告：轨迹评估 / 每日洞察 / 交互模式观察 |
| monitor-system-probes | apps/api/src/modules/ops/monitor-system-probes.ts | Monitor Agent — 系统/知识级探测与自修复 |
| monitor.service | apps/api/src/modules/ops/monitor.service.ts | Monitor Service - 健康监控 + NA Step 7 渐进告警 |
| monitoring.routes | apps/api/src/modules/ops/monitoring.routes.ts | GET /overview — D16: 监控指标聚合（任务流健康/入口转化/人工干预北极星/端到端周期/ |
| monitoring.service | apps/api/src/modules/ops/monitoring.service.ts | 平均封装开销比 = mean(injectedTokens / executionTokens)，即 studio 包装层 |
| ops-rules | apps/api/src/modules/ops/ops-rules.ts | Ops Rules — 运行时数据，不在代码里 |
| ops.service | apps/api/src/modules/ops/ops.service.ts | Ops Service — 系统生命周期守护 |
| prometheus-metrics | apps/api/src/modules/ops/prometheus-metrics.ts | agent-studio Prometheus 指标 |
| system-health | apps/api/src/modules/ops/system-health.ts | 系统健康采集模块（纯代码，零 LLM） |
| types | apps/api/src/modules/ops/types.ts | Monitor Agent 告警类型定义（P2-d 自 agents/types.ts 拆分，随 monitor 子系统归属） |
| types | apps/api/src/modules/triage/types.ts | Triage Agent 类型定义（P2-d 自 agents/types.ts 拆分，随 triage 子系统归属） |
| types | apps/web/src/components/pmo/types.ts | PMO 页面共享领域类型 — KR / OKR / Project |
| error-class | apps/api/src/modules/triage/error-class.ts | Triage ErrorClass — B1-007: 八类错误标签 + 严重度三级 + 策略路由 |
| library | apps/api/src/modules/library/ | GET /api/v1/library（#155 阅览室：跨项目 .studio/ 聚合只读）|
| api | apps/web/src/api/ | Channel API — list + publish 发布 |
| hooks | apps/web/src/hooks/ | Channel SSE hook — B2: EventSource 实时推送替代 3s 轮询 |
| stores | apps/web/src/stores/ | agentStore |
| setup | apps/web/src/test/setup.ts | setup |
| utils | apps/web/src/utils/ | Lightweight toast notification system (zero dependencies) |
| services | packages/studio-agent/src/services/ | Output Capture — 进度读取 + 输出文件收集 + session 指标记录 |
| workspaces | apps/api/src/modules/workspaces/ | Local Workspace Registration — AS-020 P2-04 |
| stream-json-parser | packages/studio-shared/src/llm/stream-json-parser.ts | Stream-JSON Parser — 解析 Claude CLI --output-format stream-json 输出 |
| unified-query | apps/api/src/modules/knowledge/engine/unified-query.ts | UnifiedQuery — dual-store unified query layer. |
| triggers | apps/api/src/modules/triggers/ | Cron Matcher — minimal cron expression evaluator (3.28c-4) |
| workunit | apps/api/src/modules/workunit/ | WorkUnit API 路由 (AS-025 §3.28c-1, §5.16) |
| anomaly-detector | packages/studio-shared/src/stats/anomaly-detector.ts | 计算数组的均值和标准差（总体标准差） |
| projects | apps/api/src/modules/projects/ | AC-D1+D3: Project Discovery Service |
| requirements | apps/api/src/modules/requirements/ | REQ 绑定解析（vision §5.3）— @mention 派发 / convert-to-task 共用。 |
| evolution | apps/api/src/modules/evolution/ | E1 约束进化：提案生效器（applier）。 |
| webhook.routes | apps/api/src/modules/deploy/webhook.routes.ts | Deploy Webhook — GitHub push 事件触发的部署入口（触发式部署，替代每分钟轮询的主通道） |
| pmo | apps/web/src/components/pmo/ | WU → 泳道。F6 铁律：分列只准看 deriveDisplayState 派生列（done 缺 L3 回「评审中」等人工确认）。 |
| dismissed | apps/web/src/components/setup/dismissed.ts | 角色配置引导弹框的会话级 dismiss 标记（sessionStorage key 与检查函数； |
| useTheme | apps/web/src/contexts/useTheme.ts | 使用主题 Hook |
| completion-extraction | apps/api/src/modules/role-memory/completion-extraction.ts | completion-extraction (#99) — WU 收尾批量提取钩子 |
| role-memory | apps/api/src/modules/role-memory/role-memory.ts | role-memory (#98) — 角色记忆存储服务 |
| transcript-archive | apps/api/src/modules/transcripts/transcript-archive.ts | transcript-archive — transcript 归档器（#97，#88 子票） |
| distill | apps/api/src/modules/distill/ | 蒸馏主链路最小闭环（#143）：门槛检测纯函数 + distill_proposal 人审卡 + approve 执行 + runs.jsonl 运行记录 |
| App | apps/web/src/App.tsx | App.tsx - Agent Studio - 路由重构 |
| AuthModal | apps/web/src/components/AuthModal.tsx | 隐形认证 — 仅通过手势触发（双击 ⚡ 或 Ctrl+Enter） |
| DiscussionPanel | apps/web/src/components/DiscussionPanel.tsx | DiscussionPanel — WorkUnit 讨论空间（MVP-4） |
| LandingPage | apps/web/src/components/LandingPage.tsx | Lurk Wall: 个人网站展示页 — 不提示登录，不显示入口 |
| MoreDropdown | apps/web/src/components/MoreDropdown.tsx | MoreDropdown.tsx - "更多"下拉菜单组件（L4 高级功能） |
| NotificationBell | apps/web/src/components/NotificationBell.tsx | Notification Bell — B2-003: 通知中心 |
| PmoNumberBadge | apps/web/src/components/PmoNumberBadge.tsx | PMO 号显示组件 - GEN-005 |
| TopNav | apps/web/src/components/TopNav.tsx | TopNav.tsx - 顶部导航栏组件（L1 核心功能） |
| TriageBanner | apps/web/src/components/TriageBanner.tsx | Triage Global Banner — B2-005: 页面顶部常驻告警横幅 |
| AuthorAvatar | apps/web/src/components/channel/AuthorAvatar.tsx | AuthorAvatar — 频道消息作者头像：人类 = 品牌色 + 用户名首字（用户传了 avatar 图则用图）； |
| ChannelInput | apps/web/src/components/channel/ChannelInput.tsx | Channel message input — AC-C1: @mention autocomplete + AC-C2: reply mode |
| ChannelMemberManager | apps/web/src/components/channel/ChannelMemberManager.tsx | Channel Member Manager — AC-B frontend gap |
| ChannelMessageItem | apps/web/src/components/channel/ChannelMessageItem.tsx | Channel message renderer — AC-C2: reply button + AC-C3: thread + AC-E3: Convert to Task |
| ChannelRail | apps/web/src/components/channel/ChannelRail.tsx | ChannelRail — Mission Control 左栏：频道列表（未读 badge + agent 在线数）+ Agent 状态 |
| ConvertToTaskDialog | apps/web/src/components/channel/ConvertToTaskDialog.tsx | AC-E3: Convert to Task dialog — LLM suggestion + form |
| KnowledgeConfirmCard | apps/web/src/components/channel/KnowledgeConfirmCard.tsx | Knowledge confirm / retract card — B1-008/B1-010 |
| RequirementsDocCard | apps/web/src/components/channel/RequirementsDocCard.tsx | RequirementsDoc inline card — B1-001/B1-003, M2 quality gate |
| WorkUnitDrawer | apps/web/src/components/channel/WorkUnitDrawer.tsx | WorkUnitDrawer — Mission Control 右抽屉：WorkUnit 详情 / REQ 全链路 |
| GapCards | apps/web/src/components/knowledge/GapCards.tsx | 知识库页面六类 Gap 明细卡片（2026-08 工单 34 从 pages/KnowledgePage.tsx 抽出，纯展示无逻辑变更） |
| MarkdownBody | apps/web/src/components/knowledge/MarkdownBody.tsx | Markdown 正文渲染 — WikiDocPage 正文方案（2026-07-31 §10 任务 4b） |
| RequirementChainPanel | apps/web/src/components/requirement/RequirementChainPanel.tsx | REQ 全链路面板（vision §5.3）— 展示 GET /requirements/:id/chain |
| ThemeSettings | apps/web/src/components/settings/ThemeSettings.tsx | 主题设置 section（从 pages/Settings.tsx 抽取，工单 35-E3） |
| FirstRoleSetupModal | apps/web/src/components/setup/FirstRoleSetupModal.tsx | AC-2.3（F2，2026-07-28）: 无已配置 provider 的用户角色时弹框提醒 |
| StudioRoleSetupModal | apps/web/src/components/setup/StudioRoleSetupModal.tsx | AC-2.2: studio 角色 provider=null 弹框提醒 |
| Button | apps/web/src/components/ui/Button.tsx | Button — 带 loading 态的通用按钮，包装 theme.css 的 .btn / .btn-{variant} / .btn-sm 类体系 |
| ConfirmDialog | apps/web/src/components/ui/ConfirmDialog.tsx | ConfirmDialog — 确认/警示弹窗：替代原生 window.confirm / alert |
| ManualTaskButton | apps/web/src/components/ui/ManualTaskButton.tsx | ManualTaskButton — 「手动任务」按钮：点击执行 → loading → toast 反馈 |
| Modal | apps/web/src/components/ui/Modal.tsx | Reusable modal overlay + content shell. |
| Select | apps/web/src/components/ui/Select.tsx | Select — 主题感知下拉选择，原生 <select> 的 drop-in 替代 |
| EvidenceLedger | apps/web/src/components/workunit/EvidenceLedger.tsx | EvidenceLedger — F6 证据台账 L1/L2/L3 共享组件（WorkUnitDrawer 抽屉变体 / WorkUnitDetailPage 卡片变体） |
| ExecutionSteps | apps/web/src/components/workunit/ExecutionSteps.tsx | ExecutionSteps — WU 过程可视化：执行步事件流（思考/工具调用/skill 注入/用量），SSE 步级刷新。 |
| ReviewHint | apps/web/src/components/workunit/ReviewHint.tsx | AC-2.4（F4 2026-07-28 改口径）: WorkUnit in_review 且频道无可认领成员时的前端提醒横幅 |
| SelfReviewBadge | apps/web/src/components/workunit/SelfReviewBadge.tsx | F6（决策 5）自评标记：频道内除实现者外无人可评时，评审由实现者自评兜底。 |
| TreeTokenDrawer | apps/web/src/components/workunit/TreeTokenDrawer.tsx | TreeTokenDrawer - 树级 token 开销展示（AC-5.4 ~ AC-5.7） |
| ThemeContext | apps/web/src/contexts/ThemeContext.tsx | 获取系统主题偏好 |
| main | apps/web/src/main.tsx | main |
| AgentDashboardPage | apps/web/src/pages/AgentDashboardPage.tsx | AgentDashboard — 角色（AgentProfile）作战视图（2026-07-31 全流程串联 UX 重构 §5.2） |
| AgentDetailPage | apps/web/src/pages/AgentDetailPage.tsx | AgentDetailPage — /agents/:profileId（2026-07-31 全流程串联 UX 重构 §5.3） |
| AuditLogsPage | apps/web/src/pages/AuditLogsPage.tsx | 审计日志页面 - AR-012 |
| ChannelDetailPage | apps/web/src/pages/ChannelDetailPage.tsx | 线程内过程消息折叠/聚合：连续 ≥3 条「过程消息」收成一组（默认折叠，点击展开）。 |
| KnowledgePage | apps/web/src/pages/KnowledgePage.tsx | 知识库页面 — 累积知识浏览 |
| MonitoringPage | apps/web/src/pages/MonitoringPage.tsx | MonitoringPage — Agent Network MVP-6 |
| NotFoundPage | apps/web/src/pages/NotFoundPage.tsx | 404 页面 - 路由表兜底（未匹配路径） |
| PMOPage | apps/web/src/pages/PMOPage.tsx | PMOPage - PMO 管理主页面（项目 + OKR；三个弹窗已抽至 components/pmo/，工单 33） |
| ProjectDetailPage | apps/web/src/pages/ProjectDetailPage.tsx | Project 详情页 - GEN-005 + FL-013 |
| WorkUnitDetailPage | apps/web/src/pages/WorkUnitDetailPage.tsx | WorkUnitDetailPage — /workunits/:id WU 详情页（全站跳转枢纽，2026-07 agents-pmo-flow-ux §5.4） |
| WorkUnitListPage | apps/web/src/pages/WorkUnitListPage.tsx | WorkUnitListPage |
| WorkspacePage | apps/web/src/pages/WorkspacePage.tsx | WorkspacePage — AC Group 5: runtime list + create role dialog |
| OpportunitiesPanel | apps/web/src/components/workunit/OpportunitiesPanel.tsx | OpportunitiesPanel — #163 T8-E2 巡检机会清单卡片（WU 详情页用） |
| LibraryDocPage | apps/web/src/pages/LibraryDocPage.tsx | #155 T5: Library 文档详情页 — 只读 |
| LibraryPage | apps/web/src/pages/LibraryPage.tsx | #155 T5: Library 阅览室 — 跨项目 .studio/ 聚合只读层 |
| transcript.routes | apps/api/src/modules/transcripts/transcript.routes.ts | Transcript 只读路由（#174，#60 C5） |
| EventSearchPanel | apps/web/src/components/monitoring/EventSearchPanel.tsx | EventSearchPanel — #180 事件检索面板（#60 决策 Q3a） |
| NeedsAttentionSection | apps/web/src/components/monitoring/NeedsAttentionSection.tsx | NeedsAttentionSection — #184 监控页概览 Tab 顶部「需要处理」区（#62 D4 + #60 IA：行动信号 > 健康度量 > 参考资料） |
| BlockedActions | apps/web/src/components/workunit/BlockedActions.tsx | BlockedActions — #185（决策 #87 D1/D3/D4/D5）：blocked WU 的 Web 处置组件 |
| TranscriptViewer | apps/web/src/components/workunit/TranscriptViewer.tsx | TranscriptViewer — #174: WU 会话原文（transcript）只读查看器（#60 C5） |
| BlockedByList | apps/web/src/components/workunit/BlockedByList.tsx | #116: 依赖（metadata.blockedBy）清单共享组件 — WorkUnitListPage 被阻塞行展开 / WorkUnitDetailPage「依赖与验收」卡复用。 |
| execution-rows | apps/web/src/components/workunit/execution-rows.ts | active WU 列表 + 最新步事件索引 → 状态条模型（顺序保持输入序）。 |
| AnalysisConfirmCard | apps/web/src/components/channel/AnalysisConfirmCard.tsx | AnalysisConfirmCard — #284（决策 #250 D6）analysis 接力卡 |
| ChannelCurrentPmoChip | apps/web/src/components/channel/ChannelCurrentPmoChip.tsx | #272（决策 #251 Q6）：顶栏「当前 PMO」chip。 |
| ChannelDefaultProjectSelect | apps/web/src/components/channel/ChannelDefaultProjectSelect.tsx | #272（决策 #251 Q2'）：顶栏「默认工程」= 本地 repo 下拉。 |
| ChannelNeedInputChip | apps/web/src/components/channel/ChannelNeedInputChip.tsx | #279（决策 #250 D4）：顶栏 NEED_INPUT 待办 chip。 |
| CreateChannelForm | apps/web/src/components/channel/CreateChannelForm.tsx | #272（决策 #251 Q3/Q7）：创建频道表单单一实现 —— ChannelListPage 与 ChannelRail 共用。 |
| FileRefChip | apps/web/src/components/channel/FileRefChip.tsx | #285（决策 #249 §5）：agent 消息正文 inline-code 路径 token 染「文件 chip」。 |
| NeedInputOptions | apps/web/src/components/channel/NeedInputOptions.tsx | #267（决策 #250 D3）: NEED_INPUT 结构化选项卡 — meta.options[] 全仓首发落地。 |
| ProjectCandidatesSection | apps/web/src/components/settings/ProjectCandidatesSection.tsx | 工程候选管理 section（#266，决策 #258）：归属问答候选集排除清单管理。 |
| AssigneeLabel | apps/web/src/components/workunit/AssigneeLabel.tsx | 负责人展示标签（#290 清单 #24）——解析到角色名则渲染 @名字 并链到 /agents/:roleId； |
| service | apps/api/src/modules/auth/service.ts | 认证服务 - Auth Service |
| card | apps/api/src/modules/review-proposal/card.ts | review-proposal/card (#351) — 人审提案卡投放 #系统 频道（唯一正本） |
| registry | apps/api/src/modules/review-proposal/registry.ts | review-proposal/registry (#351) — 人审提案卡 adapter 注册表（kind → adapter） |
| routes | apps/api/src/modules/review-proposal/routes.ts | review-proposal/routes (#351) — 人审提案卡通用端点（approve/reject/status，kind 走注册表分发） |
| service | apps/api/src/modules/review-proposal/service.ts | review-proposal/service (#351) — 人审提案卡生命周期（唯一正本） |
| store | apps/api/src/modules/review-proposal/store.ts | review-proposal/store (#351) — 人审提案卡通用存取（append-only JSONL + 状态墓碑折叠） |
| review-adapter | apps/api/src/modules/knowledge/review-adapter.ts | review-adapter (#355) — knowledge 提案审批 adapter（接线 review-proposal 正本） |
| review-adapter | apps/api/src/modules/role-memory/review-adapter.ts | review-adapter (#353) — role-memory 人审提案 adapter（接线 review-proposal 正本） |
| review-adapter | apps/api/src/modules/skills/review-adapter.ts | review-adapter (#354) — skills 提案审批 adapter（接线 review-proposal 正本） |
| ReviewProposalCard | apps/web/src/components/channel/ReviewProposalCard.tsx | ReviewProposalCard — #352 人审提案卡合一壳（ADR 2026-08-25 决策 5） |
| proposalCardConfigs | apps/web/src/components/channel/proposalCardConfigs.tsx | 人审提案卡配置（#352，ADR 2026-08-25 决策 5）：6 张提案卡坍缩为「条目清单 + 文案」纯数据配置。 |
| ChannelActivityRail | apps/web/src/components/channel/ChannelActivityRail.tsx | #394 频道动态右栏（spec §4.1–4.3，#381 定稿变体 B）——300px REQ 链路卡栏： |
| CreateRoleModal | apps/web/src/components/monitoring/CreateRoleModal.tsx | 创建角色弹框（#397，redesign §6.4：弹框不跳页——上下文不丢） |
| MonitorSection | apps/web/src/components/monitoring/MonitorSection.tsx | MonitorSection — #398 监控页区块容器（spec §7.5 文案定稿模式） |
| RoleCard | apps/web/src/components/monitoring/RoleCard.tsx | AgentDashboard 信息全卡（#397，redesign-2026-08 §6 定稿变体 B）：四层构成自上而下层级递减—— |
| alertGrouping | apps/web/src/components/monitoring/alertGrouping.ts | alertGrouping — #398 监控页「需要处理」告警分组（spec §7.3） |
| charts | apps/web/src/components/monitoring/charts.tsx | charts — #398 监控页图表小组件（spec §7.4：div/CSS 手搓，零图表库，承 #396 TreeTokenChart 先例） |
| BackButton | apps/web/src/components/ui/BackButton.tsx | #393 全站详情页统一返回按钮（spec §4.4）：左上「← 返回」（14px / 6×12 padding） |
| ExecutionFlow | apps/web/src/components/workunit/ExecutionFlow.tsx | ExecutionFlow — #396 WU 详情页「执行过程」重设计（spec §5.3）：stat 摘要行 + 纵向 step 链。 |
| StationStepper | apps/web/src/components/workunit/StationStepper.tsx | StationStepper / LifecycleEventChips — #396 WU 详情页顶部共享定位条（spec §5.1/§5.3） |
| TreeTokenChart | apps/web/src/components/workunit/TreeTokenChart.tsx | TreeTokenChart — #396 WU 详情页 Token 开销图表化（spec §5.4，零图表库手搓） |
| ChannelHomeRedirect | apps/web/src/pages/ChannelHomeRedirect.tsx | #393 频道首页重定向 — `/` 与 `/channels` 唯一入口（频道列表页已删除，spec §2） |
| AgentAvatar | apps/web/src/components/channel/AgentAvatar.tsx | AgentAvatar — #440 Phase 4：per-agent identicon 式确定性头像。 |
| SuggestionChips | apps/web/src/components/channel/SuggestionChips.tsx | SuggestionChips — #440 Phase 1：频道输入框上方的建议片； |
| UnifiedEntryContent | apps/web/src/components/knowledge/UnifiedEntryContent.tsx | #435 B7：统一视图条目内容消化呈现——JSON 结构化键值列表；文本超 200 字符截断 + 展开/收起， |
| MetaStrip | apps/web/src/components/ui/MetaStrip.tsx | MetaStrip — #440 Phase 3：详情页标题下密排元信息条。 |
| ChannelWorkBar | apps/web/src/components/channel/ChannelWorkBar.tsx | ChannelWorkBar — 频道工作条：合并 ChannelLiveBars（#242/#322 live 实况）与 |
| ChannelTopbarMenu | apps/web/src/components/channel/ChannelTopbarMenu.tsx | ChannelTopbarMenu — E1（2026-09 页面重设计，docs/plans/2026-09-page-redesign.md）： |
| WuGateActions | apps/web/src/components/workunit/WuGateActions.tsx | WuGateActions — WU 审查闸门动作三处合一（2026-09 页面重设计 E2-4，docs/plans/2026-09-page-redesign.md）： |
| action-center.service | apps/api/src/modules/action-center/action-center.service.ts | 行动中心派生服务（#468 统一行动中心）。 |
| routes | apps/api/src/modules/action-center/routes.ts | 行动中心 API 路由（#468） |
| routes | apps/api/src/modules/audit-logs/routes.ts | GET /api/audit-logs - 查询审计日志 |
| routes | apps/api/src/modules/auth/routes.ts | GET /api/v1/auth/status |
| routes | apps/api/src/modules/companies/routes.ts | Company API 路由 |
| routes | apps/api/src/modules/discord/routes.ts | Discord Interactions Endpoint |
| routes | apps/api/src/modules/harness/routes.ts | FL-029: Harness Monitoring Routes (T-015)（挂载门面） |
| routes | apps/api/src/modules/knowledge/routes.ts | 知识库 API - 公司数字资产管理（挂载门面） |
| routes | apps/api/src/modules/mcp/routes.ts | MCP HTTP Routes |
| routes | apps/api/src/modules/notifications/routes.ts | 通知 API 路由 |
| routes | apps/api/src/modules/pmo/routes.ts | 收集请求里的 gitRepo/gitRepos 候选（仅非空字符串；空串视为未传，与既有口径一致） |
| routes | apps/api/src/modules/review-proposal/routes.ts | review-proposal/routes (#351) — 人审提案卡通用端点（ADR 决策 4） |
| routes | apps/api/src/modules/skills/routes.ts | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| routes | apps/api/src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| ChannelRoutingEditor | apps/web/src/components/channel/ChannelRoutingEditor.tsx | ChannelRoutingEditor — #466：频道级「阶段→角色」路由表编辑（一屏三行下拉）。 |
| PlanRulingCard | apps/web/src/components/channel/PlanRulingCard.tsx | PlanRulingCard — #467：裁决轮接力卡（plan 一脉会话内的一次性人闸） |
| RoleSkillsModal | apps/web/src/components/monitoring/RoleSkillsModal.tsx | 角色技能编辑弹框（#462：role.skills 显式声明 → 注入索引候选，与 WU +skill 点名同权） |
| icons | apps/web/src/components/ui/icons.tsx | #474 图标策略定稿：全去 emoji——导航/徽章统一用本文件的 stroke SVG 图标组件。 |
| StaleSleepBadge | apps/web/src/components/workunit/StaleSleepBadge.tsx | #464：「已沉睡」徽标 —— 72h 认领陈旧守卫命中的 WU。 |
| CommandPalette | apps/web/src/components/CommandPalette.tsx | CommandPalette — Cmd/Ctrl+K 全局搜索面板（批次 D-2 项 8，docs/plans/2026-09-ui-interaction-polish.md）。 |
| Skeleton | apps/web/src/components/ui/Skeleton.tsx | Skeleton — 批次 E-2 静态骨架占位（docs/plans/2026-09-ui-polish-batch-e.md AC1） |
| routes | apps/api/src/modules/action-center/routes.ts | 行动中心 API 路由（#468） |
| routes | apps/api/src/modules/audit-logs/routes.ts | GET /api/audit-logs - 查询审计日志 |
| routes | apps/api/src/modules/auth/routes.ts | GET /api/v1/auth/status |
| routes | apps/api/src/modules/companies/routes.ts | Company API 路由 |
| routes | apps/api/src/modules/discord/routes.ts | Discord Interactions Endpoint |
| routes | apps/api/src/modules/harness/routes.ts | FL-029: Harness Monitoring Routes (T-015)（挂载门面） |
| routes | apps/api/src/modules/knowledge/routes.ts | 知识库 API - 公司数字资产管理（挂载门面） |
| routes | apps/api/src/modules/mcp/routes.ts | MCP HTTP Routes |
| routes | apps/api/src/modules/notifications/routes.ts | 通知 API 路由 |
| routes | apps/api/src/modules/pmo/routes.ts | 收集请求里的 gitRepo/gitRepos 候选（仅非空字符串；空串视为未传，与既有口径一致） |
| routes | apps/api/src/modules/review-proposal/routes.ts | review-proposal/routes (#351) — 人审提案卡通用端点（ADR 决策 4） |
| routes | apps/api/src/modules/skills/routes.ts | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| routes | apps/api/src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| NotifyChannelsSection | apps/web/src/components/settings/NotifyChannelsSection.tsx | 通知渠道 section（#525 P2-6）：企业微信群机器人 webhook + ClawBot（个人微信）扫码绑定 + 浏览器通知总开关。 |
| ChannelStreamBody | apps/web/src/components/channel/ChannelStreamBody.tsx | 频道消息流结构组件（#531，架构评审 2026-09-14 候选 3）：消费 useChannelStream 产物， |
| ChannelMessageEnv | apps/web/src/components/channel/ChannelMessageEnv.tsx | 频道消息环境（#547，架构评审 2026-09-15 候选 B3，grilling 已决）： |
| ApproveDialogShell | apps/web/src/components/ui/ApproveDialogShell.tsx | ApproveDialogShell — 审批弹窗公共壳（docs/plans/2026-09-web-ux-optional-fixes.md Step 3， |
| PlanDirectionCard | apps/web/src/components/channel/PlanDirectionCard.tsx | PlanDirectionCard — #567：方向锁定接力卡（plan 一脉会话内方向人闸，裁决轮前置环节） |
| agent-decision | apps/api/src/modules/audit-logs/agent-decision.ts | audit-logs/agent-decision (#591 B 类) — agent 自主决策埋点统一入口 |
| proposal-source | apps/api/src/modules/audit-logs/proposal-source.ts | audit-logs/proposal-source (#591 A 类) — review-proposal 正本的聚合读面 |
| DeleteRoleDialog | apps/web/src/components/monitoring/DeleteRoleDialog.tsx | 删除角色确认框（#630，ADR 2026-09-23 决策 5）：删除能力服务端早已完整（清频道成员与路由指名、 |
| RoleFormModal | apps/web/src/components/monitoring/RoleFormModal.tsx | 角色表单唯一正本（#630，ADR 2026-09-23-role-form-module 决策 1/2/3）： |
| seed | packages/studio-skill/src/seed.ts | seed — 内置 skill 库首启播种与升级（#223） |
| agent-loop | apps/api/src/bootstrap/agent-loop.ts | ── AS-026: AgentLoop per AgentProfile ── |
| bridges | apps/api/src/bootstrap/bridges.ts | ── 事件订阅初始化（workunit.status_changed 等 → 各域消费者）── |
| channels | apps/api/src/bootstrap/channels.ts | ── Channel 初始化（Goal 管线需要）── |
| config | apps/api/src/bootstrap/config.ts | ── 配置加载（无论怎么启动都会执行）── |
| handlers | apps/api/src/bootstrap/handlers.ts | ── Trigger EXECUTE handler 注册（周期扫描类）── |
| lifecycle | apps/api/src/bootstrap/lifecycle.ts | ── HTTP 服务生命周期：错误兜底 + listen + 优雅关闭 ── |
| migrations | apps/api/src/bootstrap/migrations.ts | ── 数据区迁移 + 启动对账 ── |
| seed | apps/api/src/bootstrap/seed.ts | ── 内置数据播种 ── |
| services | apps/api/src/bootstrap/services.ts | ── 核心服务启动（监控/审计/rollup/巡检/进化调度）── |
| tunnel | apps/api/src/bootstrap/tunnel.ts | ── Cloudflared Tunnel — 自动重启守护 + URL 变化通知 ── |
| warmup | apps/api/src/bootstrap/warmup.ts | ── 冷启动异步任务（全部 fire-and-forget，不阻塞启动）── |
| types | packages/studio-agent/src/services/types.ts | Executor 公共类型 |
| types | packages/studio-skill/src/types.ts | Skill 定义类型 |
| incident-notification | apps/api/src/modules/triage/incident-notification.ts | incident 落通知（#468 行动中心）：incident.created/escalated 处理点同步写 |
| incident-store | apps/api/src/modules/triage/incident-store.ts | incident-store（#255）— incidents.jsonl append-only 存储语义 |
| triage.service | apps/api/src/modules/triage/triage.service.ts | Triage Service — incident response: diagnose → classify → act → resolve/escalate |
| types | apps/api/src/modules/triage/types.ts | Triage Agent 类型定义（P2-d 自 agents/types.ts 拆分，随 triage 子系统归属） |
| types | apps/web/src/components/pmo/types.ts | PMO 页面共享领域类型 — KR / OKR / Project |
| channel | apps/web/src/api/channel.ts | Channel API — B1-001 + Phase 2 (AC-B4/C3/E3) |
| workunit | apps/web/src/api/workunit.ts | 从 GET /events?type=workunit:tokens 的响应行中解析某个 WorkUnit 的 token 事件。 |
| ChannelGuidance | apps/web/src/components/channel/ChannelGuidance.tsx | ChannelGuidance — 频道引导片区（P3-b 自 ChannelDetailPage 切出）： |
| ChannelStreamHead | apps/web/src/components/channel/ChannelStreamHead.tsx | ChannelStreamHead — 消息流头部块（P3-b 自 ChannelDetailPage 切出）： |
| ChannelTopbar | apps/web/src/components/channel/ChannelTopbar.tsx | ChannelTopbar — 频道页顶栏（P3-b 自 ChannelDetailPage 切出）： |
| channel | apps/web/src/types/channel.ts | 频道域客户端本地类型（P3-a 自 api/channel.ts 迁出——api 层不声明导出类型， |
| readiness | apps/api/src/bootstrap/readiness.ts | ── readiness 状态（2026-10-03 根因修复 B 批）── |
| sse | apps/web/src/types/sse.ts | SSE 客户端类型（P3-a 自 api/sseHooks.ts 迁出——api 层不声明导出类型）。 |
| soft-steps | apps/api/src/bootstrap/soft-steps.ts | ── 「失败只 log 不拒启」装配纪律的唯一固化点（#686）── |
| audit-service | apps/api/src/modules/audit-logs/audit-service.ts | Audit Service - 审计日志服务 (AR-012) |
| notification-service | apps/api/src/modules/notifications/notification-service.ts | 通知服务 |
| change-analyzer.service | apps/api/src/modules/specs/change-analyzer.service.ts | 变更分析服务 |
| change-history.service | apps/api/src/modules/specs/change-history.service.ts | 变更历史服务 |
| gate-checker.service | apps/api/src/modules/specs/gate-checker.service.ts | 门禁检查服务 |
| change.types | apps/api/src/modules/specs/types/change.types.ts | Spec 变更分级类型定义 |
| gate.types | apps/api/src/modules/specs/types/gate.types.ts | 门禁类型定义 |
| routes | apps/api/src/modules/action-center/routes.ts | 行动中心 API 路由（#468） |
| routes | apps/api/src/modules/audit-logs/routes.ts | GET /api/audit-logs - 查询审计日志 |
| routes | apps/api/src/modules/auth/routes.ts | GET /api/v1/auth/status |
| routes | apps/api/src/modules/companies/routes.ts | Company API 路由 |
| routes | apps/api/src/modules/discord/routes.ts | Discord Interactions Endpoint |
| routes | apps/api/src/modules/harness/routes.ts | FL-029: Harness Monitoring Routes (T-015)（挂载门面） |
| routes | apps/api/src/modules/knowledge/routes.ts | 知识库 API - 公司数字资产管理（挂载门面） |
| routes | apps/api/src/modules/mcp/routes.ts | MCP HTTP Routes |
| alert-notifier | apps/api/src/modules/notifications/alert-notifier.ts | 告警通知出口（P0 观测性修复 4；#682 自 utils/notifier.ts 并入 notifications 模块）。 |
| clawbot-client | apps/api/src/modules/notifications/channels/clawbot-client.ts | #525 P2-6：ClawBot（iLink 协议）客户端 —— 扫码绑定 + 文本发送 |
| config-store | apps/api/src/modules/notifications/channels/config-store.ts | #525 P2-6：/settings「通知渠道」配置存储 —— ~/.studio 数据区配置文件读写 |
| routes | apps/api/src/modules/notifications/channels/routes.ts | #525 P2-6：/api/v1/notify-channels —— /settings「通知渠道」配置区读写 API |
| wecom-client | apps/api/src/modules/notifications/channels/wecom-client.ts | 企业微信群机器人 markdown 发送唯一出口（#525 review 收口）： |
| discord-notifier | apps/api/src/modules/notifications/discord-notifier.ts | Discord 通知工具 |
| outbound-notify.routes | apps/api/src/modules/notifications/outbound-notify.routes.ts | Notify API 路由 |
| outbound-notify.service | apps/api/src/modules/notifications/outbound-notify.service.ts | NotifyService - 通知服务 |
| routes | apps/api/src/modules/notifications/routes.ts | 通知 API 路由 |
| routes | apps/api/src/modules/pmo/routes.ts | 收集请求里的 gitRepo/gitRepos 候选（仅非空字符串；空串视为未传，与既有口径一致） |
| routes | apps/api/src/modules/review-proposal/routes.ts | review-proposal/routes (#351) — 人审提案卡通用端点（ADR 决策 4） |
| routes | apps/api/src/modules/skills/routes.ts | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| routes | apps/api/src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| mockMatchMedia | apps/web/src/test/mockMatchMedia.ts | #395：jsdom 无 window.matchMedia 实现——按给定视口宽度求值 (min|max)-width 媒体查询， |