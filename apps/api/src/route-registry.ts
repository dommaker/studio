/**
 * Route Registry - 模块化路由注册
 *
 * 每个条目描述一个 API 模块的路由配置。
 * 新增模块只需在此表中添加一行，无需修改 app.ts。
 */
import { Router as ExpressRouter, type Router } from 'express';
import { requireAuth, requireAdmin, requireLocalhost } from './middleware/auth.js';
import { mcpRateLimit } from './middleware/rate-limit.js';
import { logger } from '@dommaker/studio-shared';

export interface RouteEntry {
  path: string;
  router: Router;
  middleware?: import('express').RequestHandler[];
  comment?: string;
}

/**
 * 构建完整路由表（延迟加载，避免循环依赖）
 */
export async function buildRouteTable(): Promise<RouteEntry[]> {
  const [
    agentRoutes,
    executionRoutes,
    capabilitiesRoutes,
    outputsRoutes,
    auditLogRoutes,
    { specReviewRoutes },
    { notificationRoutes },
    { knowledgeRoutes, knowledgeInternalRoutes },
    pmoRoutes,
    specsRoutes,
    notifyRoutes,
    runtimeConfigRoutes,
    authRoutes,
    discordRoutes,
    larkRoutes,
    dingtalkRoutes,
    { deployWebhookRoutes },
  ] = await Promise.all([
    import('./modules/agents/routes.js').then(m => m.default),
    import('./modules/executions/routes.js').then(m => m.default),
    import('./modules/capabilities/routes.js').then(m => m.default),
    import('./modules/outputs/routes.js').then(m => m.default),
    import('./modules/audit-logs/routes.js').then(m => m.default),
    import('./modules/spec-reviews/routes.js') as Promise<{ specReviewRoutes: Router }>,
    import('./modules/notifications/routes.js') as Promise<{ notificationRoutes: Router }>,
    import('./modules/knowledge/routes.js') as Promise<{ knowledgeRoutes: Router; knowledgeInternalRoutes: Router }>,
    import('./modules/pmo/routes.js').then(m => m.default),
    import('./modules/specs/routes.js').then(m => m.default),
    import('./modules/outbound-notify/routes.js').then(m => m.default),
    import('./modules/runtime-config/routes.js').then(m => m.default),
    import('./modules/auth/routes.js').then(m => m.default),
    import('./modules/discord/routes.js').then(m => m.default),
    import('./modules/lark/routes.js').then(m => m.default),
    import('./modules/dingtalk/routes.js').then(m => m.default),
    import('./modules/deploy/webhook.routes.js') as Promise<{ deployWebhookRoutes: Router }>,
  ]);

  // SkillHub routes (FL-025)
  const { default: skillsRoutes } = await import('./modules/skills/routes.js') as { default: Router };

  // §10.6 skill 降级提案（须先于 /api/v1/skills 注册，否则被 skillsRoutes 的 GET /:id 吃掉）
  const { default: skillDemotionRoutes } = await import('./modules/skills/skill-demotion-routes.js') as { default: Router };

  // Skill proposal routes
  const { default: skillProposalRoutes } = await import('./modules/skills/skill-proposal-routes.js') as { default: Router };

  // Knowledge Import routes (冷启动导入)
  const { default: knowledgeImportRoutes } = await import('./modules/knowledge/import.routes.js') as { default: Router };

  // Company routes (FileStore 存储；PMO 页 / Settings / useCompanyId 依赖)
  const { default: companyRoutes } = await import('./modules/companies/routes.js') as { default: Router };

  // KnowledgeService HTTP API + SSE
  const { knowledgeServiceRoutes, initKnowledgeEventBridge } = await import('./modules/knowledge/knowledge-service.routes.js') as { knowledgeServiceRoutes: Router; initKnowledgeEventBridge: (es: any) => void };
  const { eventStore } = await import('./core/event-store.js');
  initKnowledgeEventBridge(eventStore);

  // MCP routes (§12.9: 系统能力 MCP 化)
  const { default: mcpRoutes } = await import('./modules/mcp/routes.js') as { default: Router };

  // Docs freshness routes (T-020)
  const { default: docsFreshnessRoutes } = await import('./modules/admin/docs-freshness.routes.js') as { default: Router };

  // Event Stream SSE routes (HZ-028)
  const { default: sseRoutes } = await import('./modules/events/sse.routes.js') as { default: Router };

  // StudioEvent CRUD routes (G30)
  const { default: eventRoutes } = await import('./modules/events/event.routes.js') as { default: Router };

  // Iron Laws routes (ex-runtime-proxy, 2026-05-14)
  const { default: ironLawsRoutes } = await import('./modules/harness/iron-laws.routes.js') as { default: Router };

  // Harness monitoring routes (T-015)
  const { default: harnessRoutes } = await import('./modules/harness/routes.js') as { default: Router };

  // CSO 验证子路由（2026-07 收紧：/api/v1/cso 只挂 validate，不再整挂 harness router——否则 /harness 的 Admin 收紧可被 /cso/* 双挂载绕过）
  const { csoRoutes } = await import('./modules/harness/cso.routes.js') as { csoRoutes: Router };

  // Environment Manager routes (HZ-023)
  const { default: environmentRoutes } = await import('./modules/environments/routes.js') as { default: Router };

  // Agent Manager routes (HZ-024)
  const { default: agentConfigRoutes } = await import('./modules/agent-configs/routes.js') as { default: Router };

  // Built-in Toolset routes (HZ-026)
  const { default: builtinToolRoutes } = await import('./modules/builtin-tools/routes.js') as { default: Router };

  // Channel routes (B1-001)
  const { default: channelRoutes } = await import('./modules/channels/channel.routes.js') as { default: Router };

  // Workspace routes (AS-020 P2)
  const { default: workspaceRoutes } = await import('./modules/workspaces/workspace.routes.js') as { default: Router };
  const { default: workspaceTokenRoutes } = await import('./modules/workspaces/token.routes.js') as { default: Router };

  // Daemon routes (AS-020 P5: HTTP Claim + Event Reporting)
  const { default: daemonRoutes } = await import('./modules/workspaces/daemon-routes.js') as { default: Router };

  // Task management routes (AS-020 P5: UI/Server task CRUD)
  const { default: taskRoutes } = await import('./modules/workspaces/task-routes.js') as { default: Router };

  // RequirementsDoc routes (B2-009)
  const { default: requirementsDocRoutes } = await import('./modules/channels/requirements-doc.routes.js') as { default: Router };

  // Wiki routes (B2-008)
  const { wikiRoutes } = await import('./modules/wiki/wiki.routes.js') as { wikiRoutes: Router };

  // Health routes (M1)
  const healthRouter = ExpressRouter();
  healthRouter.get('/', async (_req, res) => {
    try {
      const status = await Promise.race([
        (async () => {
          const { createOpsAgent } = await import('./modules/agents/ops-agent.service.js');
          return await createOpsAgent().getStatus();
        })(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      if (!status) return res.status(503).json({ status: 'degraded', error: 'health check timeout' });
      res.json({ status: status.apiResponding ? 'healthy' : 'degraded', ...status });
    } catch (e: any) {
      res.status(500).json({ status: 'error', error: String(e) });
    }
  });
  const healthRoutes = healthRouter;

  // WorkUnit routes (AS-025 §3.28c-1)
  const { default: workunitRoutes } = await import('./modules/workunit/workunit.routes.js') as { default: Router };

  // Requirement routes (REQ 需求编号体系, vision §5.3)
  const { default: requirementRoutes } = await import('./modules/requirements/requirement.routes.js') as { default: Router };

  // AgentProfile routes (AS-025 Phase 2)
  const { default: agentProfileRoutes } = await import('./modules/agents/agent-profile.routes.js') as { default: Router };

  // §10.5 角色级 token 视图（只读聚合，挂在 /api/v1/agents 下，须先于 legacy agentRoutes 注册）
  const { default: tokenUsageRoutes } = await import('./modules/agents/token-usage.routes.js') as { default: Router };

  // RuntimeInstance routes (AS-026 AC-1)
  const { default: agentInstanceRoutes } = await import('./modules/agents/agent-instance.routes.js') as { default: Router };

  // Trigger routes (3.28c-4: REST API for trigger management)
  const { triggerRouter } = await import('./modules/triggers/trigger.routes.js') as { triggerRouter: Router };

  // Evolution routes (E1 约束进化, vision §6)
  const { default: evolutionRoutes } = await import('./modules/evolution/evolution.routes.js') as { default: Router };

  // Monitoring routes (MVP-2 + MVP-6)
  const { default: monitoringRoutes } = await import('./modules/monitoring/monitoring.routes.js') as { default: Router };

  // Project Discovery routes (AC-D1+D3: local project scanning)
  const { default: projectRoutes } = await import('./modules/projects/project.routes.js') as { default: Router };

  const auth = [requireAuth()];
  // 2026-07 API 鉴权收紧（姿态 A：保持 Lurk Wall，收紧写操作+敏感信息，详见 docs/plans/2026-07-api-auth-tightening.md）
  const admin = [requireAuth(), requireAdmin()];
  const localhost = [requireLocalhost()];

  return [
    // 认证
    { path: '/api/v1/auth', router: authRoutes, comment: 'SEC-001: 认证系统' },

    // 核心业务
    { path: '/api/v1/agents', router: tokenUsageRoutes, comment: '§10.5: 角色级 token 视图（仅 /:id/token-usage，先于 legacy 注册）' },
    { path: '/api/v1/agents', router: agentRoutes },
    { path: '/api/v1/executions', router: executionRoutes },

    { path: '/api/v1/channels', router: channelRoutes, comment: 'B1-001: Channel chat interface' },
    { path: '/api/v1/requirements-docs', router: requirementsDocRoutes, comment: 'B2-009: RequirementsDoc edit' },
    { path: '/api/v1/pmo', router: pmoRoutes, comment: 'PMO-001' },
    { path: '/api/v1/companies', router: companyRoutes, middleware: auth, comment: '公司 CRUD（FileStore 存储；008912d 误删后恢复）' },
    { path: '/api/v1/workunits', router: workunitRoutes, comment: 'AS-025 §3.28c-1: WorkUnit CRUD + Claim + State machine' },
    { path: '/api/v1/requirements', router: requirementRoutes, comment: 'REQ 需求编号体系 (vision §5.3)' },
    { path: '/api/v1/agent-profiles', router: agentProfileRoutes, comment: 'AS-025 Phase 2: AgentProfile CRUD' },
    { path: '/api/v1/agent-instances', router: agentInstanceRoutes, comment: 'AS-026 AC-1: RuntimeInstance CRUD' },
    { path: '/api/v1/triggers', router: triggerRouter, middleware: admin, comment: '3.28c-4: Trigger CRUD + status' },
    { path: '/api/v1/evolution', router: evolutionRoutes, middleware: admin, comment: 'E1 约束进化：提案列表/审批/手动扫描 (vision §6)' },
    { path: '/api/v1/monitoring', router: monitoringRoutes, middleware: admin, comment: 'MVP-2/6: Agent + WorkUnit monitoring' },
    { path: '/api/v1/projects', router: projectRoutes, middleware: admin, comment: 'AC-D1+D3: Local project discovery' },

    // 能力与工具
    { path: '/api/v1/capabilities', router: capabilitiesRoutes },
    { path: '/api/v1/skills/demotion-proposals', router: skillDemotionRoutes, comment: '§10.6: skill 降级提案（先于 SkillHub 注册）' },
    { path: '/api/v1/skills', router: skillsRoutes, comment: 'FL-025: SkillHub' },
    { path: '/api/v1/skills/proposals', router: skillProposalRoutes },

    // 运行时
    { path: '/api/v1/iron-laws', router: ironLawsRoutes, comment: 'Iron Laws (ex-runtime-proxy)' },
    { path: '/api/v1/events', router: sseRoutes, comment: 'HZ-028: Event Stream SSE' },
    { path: '/api/v1/events', router: eventRoutes, middleware: auth, comment: 'G30: StudioEvent CRUD' },
    { path: '/api/v1/mcp', router: mcpRoutes, comment: '§12.9: MCP Server (rate limit via tool-registry, auth via permission service)' },
    { path: '/api/v1/outputs', router: outputsRoutes },
    { path: '/api/v1/runtime-config', router: runtimeConfigRoutes, middleware: admin, comment: 'TaskWorker 配置' },
    { path: '/api/v1/harness', router: harnessRoutes, middleware: admin, comment: 'T-015: Harness 监控集成' },
    { path: '/api/v1/cso', router: csoRoutes, comment: 'Decision #5: CSO 验证（无需认证；仅 csoRoutes，不再整挂 harness router）' },
    { path: '/api/v1/environments', router: environmentRoutes, middleware: admin, comment: 'HZ-023: Environment Manager' },
    { path: '/api/v1/agent-configs', router: agentConfigRoutes, middleware: admin, comment: 'HZ-024: Agent Manager' },
    { path: '/api/v1/builtin-tools', router: builtinToolRoutes, middleware: admin, comment: 'HZ-026: Built-in Toolset' },

    // 文档与审查
    { path: '/api/v1/spec-reviews', router: specReviewRoutes, middleware: auth },
    { path: '/api/v1/specs', router: specsRoutes, middleware: auth, comment: 'SP-002' },

    // 通知与知识
    { path: '/api/v1/notifications', router: notificationRoutes, middleware: auth },
    { path: '/api/v1/notify', router: notifyRoutes, middleware: admin, comment: 'DD-009: 出站推送（内部调用）' },
    { path: '/api/v1/knowledge', router: knowledgeRoutes, middleware: auth },
    { path: '/api/v1/knowledge-service', router: knowledgeServiceRoutes, middleware: auth, comment: 'KnowledgeService HTTP API + SSE' },
    { path: '/api/v1/knowledge/import', router: knowledgeImportRoutes, middleware: auth, comment: 'S2: 冷启动导入' },
    { path: '/api/knowledge', router: knowledgeInternalRoutes, middleware: localhost, comment: 'Internal knowledge extraction API (2026-07 收紧：本机回环限定，此前全匿名可写/盗用 LLM)' },
    { path: '/api/v1/wiki', router: wikiRoutes, comment: 'B2-008: LLM Wiki 档案馆' },

    // 运维
    { path: '/api/v1/health', router: healthRoutes, comment: 'M1: Health check' },
    { path: '/api/v1/audit-logs', router: auditLogRoutes, middleware: admin, comment: 'AR-012' },
    { path: '/api/v1/admin/docs-freshness', router: docsFreshnessRoutes, middleware: admin, comment: 'T-020: CLAUDE.md 新鲜度检查' },

    // Discord
    { path: '/api/v1/discord', router: discordRoutes, comment: 'Discord Interactions' },

    // Deploy（触发式部署：GitHub push webhook，HMAC 校验，免登录见 app.ts PUBLIC_API）
    { path: '/api/v1/deploy', router: deployWebhookRoutes, comment: 'GitHub push webhook → auto-deploy' },

    // Workspace (AS-020 P2: Daemon registration + token management)
    { path: '/api/v1/workspaces', router: workspaceRoutes, comment: 'AS-020: Workspace registration + heartbeat' },
    { path: '/api/v1/workspace-tokens', router: workspaceTokenRoutes, comment: 'AS-020: Workspace token management' },

    // Daemon (AS-020 P5: HTTP Claim + Event Reporting)
    { path: '/api/v1/daemon', router: daemonRoutes, comment: 'AS-020 P5: Daemon task claim + events' },

    // Task management (AS-020 P5: UI/Server task CRUD)
    { path: '/api/v1/workspaces', router: taskRoutes, comment: 'AS-020 P5: Task create/get/cancel' },

    // Lark (飞书)
    { path: '/api/v1/lark', router: larkRoutes, comment: '飞书机器人回调' },

    // DingTalk (钉钉)
    { path: '/api/v1/dingtalk', router: dingtalkRoutes, comment: '钉钉机器人回调' },
  ];
}
