# CAPABILITIES.md

> 最后更新: 2026-08-15

---

| 模块 | 文件 | 说明 |
|------|------|------|

| src | packages/studio-agent/src/ | studio-agent 类型定义 |
| audit-service | packages/studio-audit/src/services/audit-service.ts | Audit Service - 审计日志服务 (AR-012) |
| capability.service | packages/studio-capability/src/services/capability.service.ts | Capability Service - 能力管理服务 |
| notification-service | packages/studio-notification/src/services/notification-service.ts | 通知服务 |
| cli | packages/studio-shared/src/cli/ | 命令注册框架 |
| levels | packages/studio-shared/src/constants/levels.ts | 级别配置 - 全局统一的职级定义 |

| src | packages/studio-shared/src/ | Studio Event Bus — 替代 Redis pub/sub（2026-05-08） |
| auditor-types | packages/studio-shared/src/harness/auditor/auditor-types.ts | Auditor ↔ 其他角色协议定义（BP-013 + BP-014） |
| hooks | packages/studio-shared/src/harness/hooks/ | Agent Execution Phase Hooks |
| harness | packages/studio-shared/src/harness/ | Constraint Prompt Injection — 将 harness 约束的前置声明注入 Agent prompt |
| runtime | packages/studio-shared/src/harness/runtime/ | Harness Runtime Bootstrap — Phase 2 迁移 |

| agents | apps/api/src/modules/agents/ | SystemExecutor — 系统级 LLM 调用抽象，替代 modelGateway |
| types | packages/studio-shared/src/types/ | Goal 状态类型 — SQLite 不支持 enum，用 TypeScript 类型守卫约束 |

| utils | packages/studio-shared/src/utils/ | Shared Logger - 统一日志接口 |
| src | packages/studio-skill/src/ | SkillLoader — 按 trigger 加载 Skill，注入 Agent prompt |
| services | packages/studio-spec/src/services/ | ChangeAnalyzerService 单元测试 |
| types | packages/studio-spec/src/types/ | Spec 变更分级类型定义 |
| docs-freshness.routes | apps/api/src/modules/admin/docs-freshness.routes.ts | T-020 + T-059: CLAUDE.md + CAPABILITIES.md Freshness Check |
| auditor | apps/api/src/modules/agents/auditor/ | Auditor Service — 跨任务审计 + 周期洞察 |
| knowledge | apps/api/src/modules/agents/knowledge/ | Knowledge Curator - 知识库冷启动 + F1 每日维护 + 提取 prompt 单一来源 |
| monitor | apps/api/src/modules/agents/monitor/ | Monitor Service - 健康监控 + 渐进告警 + G31 知识沉淀闸门(precipitate→TTL) |
| ops | apps/api/src/modules/agents/ops/ | Ops Service — 系统生命周期守护 |

| triage.service | apps/api/src/modules/agents/triage/triage.service.ts | Triage Service — incident response: diagnose → classify → act → resolve/escalate |
| audit-subscriber | apps/api/src/modules/audit/audit-subscriber.ts | Audit Event Subscriber — EventBus 审计事件持久化到 DB (B0-002) |
| routes | apps/api/src/modules/audit-logs/routes.ts | GET /api/audit-logs - 查询审计日志 |
| auth | apps/api/src/modules/auth/ | POST /api/v1/auth/guest-session |
| routes | apps/api/src/modules/builtin-tools/routes.ts | builtin-tools/routes.ts — Built-in Toolset (HZ-026) |
| routes | apps/api/src/modules/capabilities/routes.ts | 从 YAML 文件读取 stage 字段 |
| channels | apps/api/src/modules/channels/ | Seed default channels on startup (B1-001) |
| companies | apps/api/src/modules/companies/ | Company API 路由 — 存储迁移 Prisma → FileStore |
| routes | apps/api/src/modules/dingtalk/routes.ts | 钉钉机器人交互回调 |
| discord | apps/api/src/modules/discord/ | B3-002/B3-003: Shared command runner for CLI and Discord |
| events | apps/api/src/modules/events/ | G30: StudioEvent API Endpoints |
| routes | apps/api/src/modules/executions/routes.ts | Execution API 路由 |
| harness | apps/api/src/modules/harness/ | Iron Laws API — 从 runtime-proxy 迁移 (2026-05-14) |
| knowledge | apps/api/src/modules/knowledge/ | DecisionChainExtractor (G-004) — 从 Meeting 辩论 + Goal 执行中提取决策链 |

| routes | apps/api/src/modules/lark/routes.ts | 飞书机器人交互回调 |

| mcp | apps/api/src/modules/mcp/ | MCP Admin Routes — tool management, permissions, audit |

| routes | apps/api/src/modules/notifications/routes.ts | 通知 API 路由 |
| outbound-notify | apps/api/src/modules/outbound-notify/ | NotifyService - 通知服务 |
| pmo | apps/api/src/modules/pmo/ | 🆕 AS-016: 获取当前季度 |
| skills | apps/api/src/modules/skills/ | SkillHub API — CRUD + 生命周期 + Agent 可发现性 + 使用统计 |
| routes | apps/api/src/modules/specs/routes.ts | POST /api/v1/specs/:id/analyze-change |
| error-class | apps/api/src/modules/triage/error-class.ts | Triage ErrorClass — B1-007: 八类错误标签 + 严重度三级 + 策略路由 |
| library | apps/api/src/modules/library/ | GET /api/v1/library（#155 阅览室：跨项目 .studio/ 聚合只读）|
| api | apps/web/src/api/ | Channel API — list + publish 发布 |
| hooks | apps/web/src/hooks/ | Channel SSE hook — B2: EventSource 实时推送替代 3s 轮询 |

| stores | apps/web/src/stores/ | agentStore |
| setup | apps/web/src/test/setup.ts | setup |
| types | apps/web/src/types.ts | types.ts - Agent Studio 类型定义 |

| utils | apps/web/src/utils/ | Lightweight toast notification system (zero dependencies) |

| services | packages/studio-agent/src/services/ | Output Capture — 进度读取 + 输出文件收集 + session 指标记录 |

| workspaces | apps/api/src/modules/workspaces/ | Local Workspace Registration — AS-020 P2-04 |

| stream-json-parser | packages/studio-shared/src/llm/stream-json-parser.ts | Stream-JSON Parser — 解析 Claude CLI --output-format stream-json 输出 |

| unified-query | apps/api/src/modules/knowledge/engine/unified-query.ts | UnifiedQuery — dual-store unified query layer. |

| loop | apps/api/src/modules/agents/loop/ | Analyze agent log for knowledge search behavior. |
| monitoring | apps/api/src/modules/monitoring/ | Monitoring Routes — Agent Network (MVP-2 + MVP-6) |
| triggers | apps/api/src/modules/triggers/ | Cron Matcher — minimal cron expression evaluator (3.28c-4) |

| workunit | apps/api/src/modules/workunit/ | WorkUnit API 路由 (AS-025 §3.28c-1, §5.16) |

| anomaly-detector | packages/studio-shared/src/stats/anomaly-detector.ts | 计算数组的均值和标准差（总体标准差） |
| projects | apps/api/src/modules/projects/ | AC-D1+D3: Project Discovery Service |

| requirements | apps/api/src/modules/requirements/ | REQ 绑定解析（vision §5.3）— @mention 派发 / convert-to-task 共用。 |

| evolution | apps/api/src/modules/evolution/ | E1 约束进化：提案生效器（applier）。 |

| webhook.routes | apps/api/src/modules/deploy/webhook.routes.ts | Deploy Webhook — GitHub push 事件触发的部署入口（触发式部署，替代每分钟轮询的主通道） |

| pmo | apps/web/src/components/pmo/ | WU → 泳道。F6 铁律：分列只准看 deriveDisplayState 派生列（done 缺 L3 回「评审中」等人工确认）。 |
| graphUtils | apps/web/src/components/knowledge/graphUtils.ts | 知识图谱节点数据 |
| statusClasses | apps/web/src/components/channel/statusClasses.ts | 频道/agent 状态点样式映射（从 ChannelRail.tsx 拆出，供 ChannelRail 与 ChannelListPage 共用） |
| dismissed | apps/web/src/components/setup/dismissed.ts | 角色配置引导弹框的会话级 dismiss 标记（sessionStorage key 与检查函数； |
| useTheme | apps/web/src/contexts/useTheme.ts | 使用主题 Hook |

| completion-extraction | apps/api/src/modules/role-memory/completion-extraction.ts | completion-extraction (#99) — WU 收尾批量提取钩子 |
| memory-proposal-card | apps/api/src/modules/role-memory/memory-proposal-card.ts | memory-proposal-card (#101) — 角色记忆草稿的人审提案卡。 |
| role-memory.routes | apps/api/src/modules/role-memory/role-memory.routes.ts | role-memory.routes (#101) — 角色记忆人审闸口的 approve/reject 端点。 |
| role-memory | apps/api/src/modules/role-memory/role-memory.ts | role-memory (#98) — 角色记忆存储服务 |
| transcript-archive | apps/api/src/modules/transcripts/transcript-archive.ts | transcript-archive — transcript 归档器（#97，#88 子票） |
| distill | apps/api/src/modules/distill/ | 蒸馏主链路最小闭环（#143）：门槛检测纯函数 + distill_proposal 人审卡 + approve 执行 + runs.jsonl 运行记录 |
| DistillProposalCard | apps/web/src/components/channel/DistillProposalCard.tsx | distill_proposal 人审卡（#143）：原料清单 + 确认蒸馏/拒绝 |
| App | apps/web/src/App.tsx | App.tsx - Agent Studio - 路由重构 |
| AuthModal | apps/web/src/components/AuthModal.tsx | 隐形认证 — 仅通过手势触发（双击 ⚡ 或 Ctrl+Enter） |
| ChannelWorkspaceSetting | apps/web/src/components/ChannelWorkspaceSetting.tsx | ChannelWorkspaceSetting |
| DiscussionPanel | apps/web/src/components/DiscussionPanel.tsx | DiscussionPanel — WorkUnit 讨论空间（MVP-4） |
| JoinComputeDialog | apps/web/src/components/JoinComputeDialog.tsx | JoinComputeDialog |
| KnowledgeGraphView | apps/web/src/components/KnowledgeGraphView.tsx | 节点颜色映射（分类色板 → theme.css `--chart-1…9`，深/浅主题各自取值） |
| LandingPage | apps/web/src/components/LandingPage.tsx | Lurk Wall: 个人网站展示页 — 不提示登录，不显示入口 |
| MoreDropdown | apps/web/src/components/MoreDropdown.tsx | MoreDropdown.tsx - "更多"下拉菜单组件（L4 高级功能） |
| NotificationBell | apps/web/src/components/NotificationBell.tsx | Notification Bell — B2-003: 通知中心 |
| OAuthCallback | apps/web/src/components/OAuthCallback.tsx | OAuth callback handler. |
| PmoNumberBadge | apps/web/src/components/PmoNumberBadge.tsx | PMO 号显示组件 - GEN-005 |
| SidebarNew | apps/web/src/components/SidebarNew.tsx | Sidebar.tsx - 侧边栏组件（最新设计） |
| TokenManager | apps/web/src/components/TokenManager.tsx | TokenManager |
| TopNav | apps/web/src/components/TopNav.tsx | TopNav.tsx - 顶部导航栏组件（L1 核心功能） |
| TriageBanner | apps/web/src/components/TriageBanner.tsx | Triage Global Banner — B2-005: 页面顶部常驻告警横幅 |
| WorkspaceStatusBar | apps/web/src/components/WorkspaceStatusBar.tsx | WorkspaceStatusBar |
| AuditorSuggestionCard | apps/web/src/components/channel/AuditorSuggestionCard.tsx | Auditor suggestion card — B3-005 |
| AuthorAvatar | apps/web/src/components/channel/AuthorAvatar.tsx | AuthorAvatar — 频道消息作者头像：人类 = 品牌色 + 用户名首字（用户传了 avatar 图则用图）； |
| ChannelInput | apps/web/src/components/channel/ChannelInput.tsx | Channel message input — AC-C1: @mention autocomplete + AC-C2: reply mode |
| ChannelMemberManager | apps/web/src/components/channel/ChannelMemberManager.tsx | Channel Member Manager — AC-B frontend gap |
| ChannelMessageItem | apps/web/src/components/channel/ChannelMessageItem.tsx | Channel message renderer — AC-C2: reply button + AC-C3: thread + AC-E3: Convert to Task |
| ChannelRail | apps/web/src/components/channel/ChannelRail.tsx | ChannelRail — Mission Control 左栏：频道列表（未读 badge + agent 在线数）+ Agent 状态 |
| ConstraintAuditCard | apps/web/src/components/channel/ConstraintAuditCard.tsx | ConstraintAuditCard — #146 存量约束退役建议人审闸口 |
| ConvertToTaskDialog | apps/web/src/components/channel/ConvertToTaskDialog.tsx | AC-E3: Convert to Task dialog — LLM suggestion + form |
| GcProposalCard | apps/web/src/components/channel/GcProposalCard.tsx | GC proposal card — #144 知识库 GC 候选清单人审闸口 |
| KnowledgeConfirmCard | apps/web/src/components/channel/KnowledgeConfirmCard.tsx | Knowledge confirm / retract card — B1-008/B1-010 |
| KnowledgeProposalCard | apps/web/src/components/channel/KnowledgeProposalCard.tsx | Knowledge proposal card — 2026-07 知识审核闭环（vision §4 提取→待审→注入，§6 人在频道审核） |
| MemoryProposalCard | apps/web/src/components/channel/MemoryProposalCard.tsx | Memory proposal card — #101 角色记忆人审闸口 |
| RequirementsDocCard | apps/web/src/components/channel/RequirementsDocCard.tsx | RequirementsDoc inline card — B1-001/B1-003, M2 quality gate |
| WorkUnitDrawer | apps/web/src/components/channel/WorkUnitDrawer.tsx | WorkUnitDrawer — Mission Control 右抽屉：WorkUnit 详情 / REQ 全链路 |
| GapCards | apps/web/src/components/knowledge/GapCards.tsx | 知识库页面六类 Gap 明细卡片（2026-08 工单 34 从 pages/KnowledgePage.tsx 抽出，纯展示无逻辑变更） |
| MarkdownBody | apps/web/src/components/knowledge/MarkdownBody.tsx | Markdown 正文渲染 — WikiDocPage 正文方案（2026-07-31 §10 任务 4b） |
| RequirementChainPanel | apps/web/src/components/requirement/RequirementChainPanel.tsx | REQ 全链路面板（vision §5.3）— 展示 GET /requirements/:id/chain |
| CompanySection | apps/web/src/components/settings/CompanySection.tsx | 公司信息 section（从 pages/Settings.tsx 抽取，工单 35-E3）：公司名称自动保存 + 无公司时创建 |
| ComputeSection | apps/web/src/components/settings/ComputeSection.tsx | 算力接入 section（从 pages/Settings.tsx 抽取，工单 35-E3）：Workspace 状态 + 加入算力弹窗 + Token 管理 |
| KnowledgeEntrySection | apps/web/src/components/settings/KnowledgeEntrySection.tsx | 公司知识库入口 section（从 pages/Settings.tsx 抽取，工单 35-E3） |
| NotifyChannelSection | apps/web/src/components/settings/NotifyChannelSection.tsx | 通知渠道 section（从 pages/Settings.tsx 抽取，工单 35-E3）：Discord/企微/Telegram 三段合并为数据驱动 |
| NotifySyncStatusHint | apps/web/src/components/settings/NotifySyncStatusHint.tsx | 通知配置同步状态提示（从 pages/Settings.tsx 抽取，工单 35-E3） |
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
| ChannelListPage | apps/web/src/pages/ChannelListPage.tsx | Channel List Page — B2: 首页 = 频道列表 + Agent 状态栏 |
| ForgotPasswordPage | apps/web/src/pages/ForgotPasswordPage.tsx | 忘记密码页面 — 输入邮箱，发送重置链接 |
| KnowledgePage | apps/web/src/pages/KnowledgePage.tsx | 知识库页面 — 累积知识浏览 |
| MonitoringPage | apps/web/src/pages/MonitoringPage.tsx | MonitoringPage — Agent Network MVP-6 |
| NotFoundPage | apps/web/src/pages/NotFoundPage.tsx | 404 页面 - 路由表兜底（未匹配路径） |
| PMOPage | apps/web/src/pages/PMOPage.tsx | PMOPage - PMO 管理主页面（项目 + OKR；三个弹窗已抽至 components/pmo/，工单 33） |
| ProjectDetailPage | apps/web/src/pages/ProjectDetailPage.tsx | Project 详情页 - GEN-005 + FL-013 |
| ResetPasswordPage | apps/web/src/pages/ResetPasswordPage.tsx | 重置密码页面 — 使用 token 设置新密码 |
| RolesSetup | apps/web/src/pages/RolesSetup.tsx | AC-2.5: 角色初始化向导页 |
| Settings | apps/web/src/pages/Settings.tsx | 设置页面 - API 配置 + 通知 + 公司 + 主题语言 |
| WikiDocPage | apps/web/src/pages/WikiDocPage.tsx | B2-008: Wiki 文档详情页 |
| WikiPage | apps/web/src/pages/WikiPage.tsx | B2-008: Wiki 主页面 — RequirementsDoc 档案馆 |
| WorkUnitDetailPage | apps/web/src/pages/WorkUnitDetailPage.tsx | WorkUnitDetailPage — /workunits/:id WU 详情页（全站跳转枢纽，2026-07 agents-pmo-flow-ux §5.4） |
| WorkUnitListPage | apps/web/src/pages/WorkUnitListPage.tsx | WorkUnitListPage |
| WorkspacePage | apps/web/src/pages/WorkspacePage.tsx | WorkspacePage — AC Group 5: runtime list + create role dialog |