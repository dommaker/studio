# CAPABILITIES.md

> 最后更新: 2026-08-08

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
| wiki | apps/api/src/modules/wiki/ | GET /api/v1/wiki |
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

