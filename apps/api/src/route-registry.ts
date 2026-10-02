/**
 * Route Registry - 模块化路由注册
 *
 * 每个条目描述一个 API 模块的路由配置。
 * 新增模块只需在此表中添加一行，无需修改 app.ts。
 */
import { Router as ExpressRouter, type Router } from 'express';
import { requireAuth, requireNotGuest, requireAdmin, requireLocalhost } from './middleware/auth.js';
import { mcpRateLimit } from './middleware/rate-limit.js';
import { logger } from '@dommaker/studio-shared';

export interface RouteEntry {
  path: string;
  router: Router;
  middleware?: import('express').RequestHandler[];
  comment?: string;
}

/**
 * 顺序敏感注册约束：before 条目必须先于 after 条目挂载。
 *
 * Express 按注册顺序匹配，同前缀挂载时先注册者优先接管请求，
 * 顺序错了不会报错而是静默路由错/404——所以用启动断言固化，fail-fast。
 */
export interface RouteOrderConstraint {
  before: { path: string; router: Router };
  after: { path: string; router: Router };
  /** 顺序约束的原因（注释固化，断言失败时随报错输出） */
  reason: string;
}

/**
 * 启动断言：校验路由表满足全部顺序约束，违反即抛错（启动失败）。
 */
export function assertRouteOrder(table: RouteEntry[], constraints: RouteOrderConstraint[]): void {
  const indexOf = (path: string, router: Router) =>
    table.findIndex(e => e.path === path && e.router === router);
  for (const c of constraints) {
    const beforeIdx = indexOf(c.before.path, c.before.router);
    const afterIdx = indexOf(c.after.path, c.after.router);
    if (beforeIdx === -1 || afterIdx === -1) {
      throw new Error(
        `[route-registry] 顺序断言失败：注册项缺失（${c.before.path} idx=${beforeIdx}, ${c.after.path} idx=${afterIdx}）。${c.reason}`,
      );
    }
    if (beforeIdx >= afterIdx) {
      throw new Error(
        `[route-registry] 注册顺序错误：${c.before.path}（指定 router）必须先于 ${c.after.path} 挂载。${c.reason}`,
      );
    }
  }
}

/**
 * 构建完整路由表（延迟加载，避免循环依赖）
 */
export async function buildRouteTable(): Promise<RouteEntry[]> {
  const [
    agentRouters,
    executionRoutes,
    auditLogRoutes,
    { notificationRoutes },
    { knowledgeRoutes, knowledgeInternalRoutes },
    pmoRouters,
    specsRoutes,
    notifyRoutes,
    authRoutes,
    discordRoutes,
    larkRoutes,
    dingtalkRoutes,
    { deployWebhookRoutes },
  ] = await Promise.all([
    import('./modules/agents/routes.js'),
    import('./modules/executions/routes.js').then(m => m.default),
    import('./modules/audit-logs/routes.js').then(m => m.default),
    import('./modules/notifications/routes.js') as Promise<{ notificationRoutes: Router }>,
    import('./modules/knowledge/routes.js') as Promise<{ knowledgeRoutes: Router; knowledgeInternalRoutes: Router }>,
    import('./modules/pmo/routes.js'),
    import('./modules/specs/routes.js'),
    import('./modules/outbound-notify/routes.js').then(m => m.default),
    import('./modules/auth/routes.js').then(m => m.default),
    import('./modules/discord/routes.js').then(m => m.default),
    import('./modules/lark/routes.js').then(m => m.default),
    import('./modules/dingtalk/routes.js').then(m => m.default),
    import('./modules/deploy/webhook.routes.js') as Promise<{ deployWebhookRoutes: Router }>,
  ]);

  // SkillHub routes (FL-025)——P2-e 拆 open/write 双 router（鉴权挂 registry entry）
  const { skillsOpenRoutes, skillsWriteRoutes } = await import('./modules/skills/routes.js');

  // §10.6 skill 降级提案（须先于 /api/v1/skills 注册，否则被 skillsOpenRoutes 的 GET /:id 吃掉）
  const { skillDemotionOpenRoutes, skillDemotionWriteRoutes } = await import('./modules/skills/skill-demotion-routes.js');

  // Skill proposal routes
  const { skillProposalOpenRoutes, skillProposalWriteRoutes } = await import('./modules/skills/skill-proposal-routes.js');

  // Company routes (FileStore 存储；PMO 页 / Settings 依赖)
  const { default: companyRoutes } = await import('./modules/companies/routes.js') as { default: Router };

  // KnowledgeService HTTP API + SSE
  const { knowledgeServiceRoutes, initKnowledgeEventBridge } = await import('./modules/knowledge/knowledge-service.routes.js') as { knowledgeServiceRoutes: Router; initKnowledgeEventBridge: () => void };
  initKnowledgeEventBridge();

  // MCP routes (§12.9: 系统能力 MCP 化)
  const { default: mcpRoutes } = await import('./modules/mcp/routes.js') as { default: Router };

  // Docs freshness routes (T-020)
  const { default: docsFreshnessRoutes } = await import('./modules/admin/docs-freshness.routes.js') as { default: Router };

  // Event Stream SSE routes (HZ-028)
  const { default: sseRoutes } = await import('./modules/events/sse.routes.js') as { default: Router };

  // StudioEvent CRUD routes (G30)
  const { eventOpenRoutes, eventWriteRoutes } = await import('./modules/events/event.routes.js');

  // Action Center routes (#468 统一行动中心)
  const { actionCenterRoutes } = await import('./modules/action-center/routes.js') as { actionCenterRoutes: Router };

  // WU transcript 只读查看 (#174, #60 C5)
  const { default: transcriptRoutes } = await import('./modules/transcripts/transcript.routes.js') as { default: Router };

  // Iron Laws routes (ex-runtime-proxy, 2026-05-14)
  const { default: ironLawsRoutes } = await import('./modules/harness/iron-laws.routes.js') as { default: Router };

  // Harness monitoring routes (T-015)
  const { default: harnessRoutes } = await import('./modules/harness/routes.js') as { default: Router };

  // CSO 验证子路由（2026-07 收紧：/api/v1/cso 只挂 validate，不再整挂 harness router——否则 /harness 的 Admin 收紧可被 /cso/* 双挂载绕过）
  const { csoRoutes } = await import('./modules/harness/cso.routes.js') as { csoRoutes: Router };

  // Built-in Toolset routes (HZ-026)
  const { default: builtinToolRoutes } = await import('./modules/builtin-tools/routes.js') as { default: Router };

  // Channel routes (B1-001)——P2-e 拆 attachment/read/write 三 router（鉴权挂 registry entry；
  // attachment 单条保 ?token= 前置 tokenQueryToHeader，鉴权留路由内）
  const { channelReadRoutes, channelWriteRoutes, channelAttachmentRoutes } = await import('./modules/channels/channel.routes.js');

  // Review proposal routes (#351: 人审提案卡通用端点，kind 走注册表分发；取代 #143/#144/#146 专有端点)
  const { reviewProposalOpenRoutes, reviewProposalWriteRoutes } = await import('./modules/review-proposal/routes.js');

  // Workspace routes (AS-020 P2)
  const { default: workspaceRoutes } = await import('./modules/workspaces/workspace.routes.js') as { default: Router };

  // Daemon (AS-020 P5) 与 Task management（AS-020 P5 UI/Server task CRUD）路由已删：
  // HTTP claim 竖井无任何消费者（客户端三件套 5a982122 已删），任务队列只进不出

  // T5 #155: library 阅览室——跨项目 .studio/ 聚合只读层
  const { libraryRoutes } = await import('./modules/library/library.routes.js') as { libraryRoutes: Router };

  // Health routes (M1)
  const healthRouter = ExpressRouter();
  healthRouter.get('/', async (_req, res) => {
    try {
      const status = await Promise.race([
        (async () => {
          const { createOpsService } = await import('./modules/agent-ops/index.js');
          return await createOpsService().getStatus();
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
  const { workunitOpenRoutes, workunitWriteRoutes } = await import('./modules/workunit/workunit.routes.js');

  // Requirement routes (REQ 需求编号体系, vision §5.3)
  const { requirementOpenRoutes, requirementWriteRoutes } = await import('./modules/requirements/requirement.routes.js');

  // AgentProfile routes (AS-025 Phase 2)
  const { agentProfileOpenRoutes, agentProfileWriteRoutes } = await import('./modules/agents/agent-profile.routes.js');

  // §10.5 角色级 token 视图（只读聚合，挂在 /api/v1/agents 下，须先于 legacy agentRoutes 注册）
  const { default: tokenUsageRoutes } = await import('./modules/agents/token-usage.routes.js') as { default: Router };

  // RuntimeInstance routes (AS-026 AC-1)
  const { agentInstanceOpenRoutes, agentInstanceWriteRoutes, agentInstanceAdminRoutes } = await import('./modules/agents/agent-instance.routes.js');

  // Trigger routes (3.28c-4: REST API for trigger management)
  const { triggerRouter } = await import('./modules/triggers/trigger.routes.js') as { triggerRouter: Router };

  // Evolution routes (E1 约束进化, vision §6)
  const { default: evolutionRoutes } = await import('./modules/evolution/evolution.routes.js') as { default: Router };

  // Monitoring routes (MVP-2 + MVP-6)
  const { default: monitoringRoutes } = await import('./modules/monitoring/monitoring.routes.js') as { default: Router };

  // Project Discovery routes (AC-D1+D3: local project scanning)
  const { default: projectRoutes } = await import('./modules/projects/project.routes.js') as { default: Router };

  // #525 P2-6: 通知渠道配置（/settings「通知渠道」配置区，消费方 = notifyAlert 告警外推）
  const { default: notifyChannelRoutes } = await import('./modules/notify-channels/routes.js') as { default: Router };

  const auth = [requireAuth()];
  // 2026-07 API 鉴权收紧（姿态 A：保持 Lurk Wall，收紧写操作+敏感信息，详见 docs/plans/2026-07-api-auth-tightening.md）
  // P2-e 声明式统一：写端点通用姿态 = 登录 + 非 Guest；读开放的路由走 open entry（生产 Lurk Wall 兜底）。
  const authNotGuest = [requireAuth(), requireNotGuest()];
  const admin = [requireAuth(), requireAdmin()];
  const localhost = [requireLocalhost()];

  const table: RouteEntry[] = [
    // 认证
    // 认证面本体：login/register/status 公开（PUBLIC_API）与 logout/admin 混合粒度是本质，鉴权留路由内
    { path: '/api/v1/auth', router: authRoutes, comment: 'SEC-001: 认证系统（混合粒度，不上移）' },

    // 核心业务
    // 顺序约束①：tokenUsageRoutes 必须先于 legacy agent open 路由挂载（见文件尾部 assertRouteOrder）。
    // 原因：两者同挂 /api/v1/agents，token-usage 只处理 GET /:id/token-usage 并放行其余路径；
    // 显式定序保证该聚合端点恒由 tokenUsageRoutes 接管，不被 legacy 路由的任何通配变更吞掉。
    { path: '/api/v1/agents', router: tokenUsageRoutes, comment: '§10.5: 角色级 token 视图（仅 /:id/token-usage，先于 legacy 注册）' },
    // P2-e：legacy agents 拆 open/write/admin 三档（原路由内挂载上移；DELETE 原 requireRole('Admin') 单挂，
    // 现 = requireAuth+requireAdmin，全部模式下状态码与错误体逐点等价）
    { path: '/api/v1/agents', router: agentRouters.agentOpenRoutes },
    { path: '/api/v1/agents', router: agentRouters.agentWriteRoutes, middleware: authNotGuest },
    { path: '/api/v1/agents', router: agentRouters.agentAdminRoutes, middleware: admin },
    // LEGACY 面：GET 开放 + POST /events 路由内 requireLocalhost（粒度混合，不上移）
    { path: '/api/v1/executions', router: executionRoutes },

    { path: '/api/v1/channels', router: channelAttachmentRoutes, comment: '附件 GET：?token= 需 tokenQueryToHeader 先于 requireAuth（registry 无 per-route 前置 middleware 能力，单条鉴权保留路由内）' },
    { path: '/api/v1/channels', router: channelReadRoutes, middleware: auth, comment: 'B1-001: Channel chat interface（读：登录即可，Guest 可读）' },
    { path: '/api/v1/channels', router: channelWriteRoutes, middleware: authNotGuest },
    // P2-e：PMO 拆 open（GET + POST parse-command）/ write / admin（DELETE project/okr）三档，
    // 鉴权全部上移（原 POST 挂 GET 不挂的双轨消除；DELETE 姿态等价变化见 agents 条注释同款说明）
    { path: '/api/v1/pmo', router: pmoRouters.pmoOpenRoutes, comment: 'PMO-001（读开放，生产 Lurk Wall 兜底）' },
    { path: '/api/v1/pmo', router: pmoRouters.pmoWriteRoutes, middleware: authNotGuest },
    { path: '/api/v1/pmo', router: pmoRouters.pmoAdminRoutes, middleware: admin },
    { path: '/api/v1/companies', router: companyRoutes, middleware: auth, comment: '公司 CRUD（FileStore 存储；008912d 误删后恢复）' },
    { path: '/api/v1/workunits', router: workunitOpenRoutes, comment: 'AS-025 §3.28c-1: WorkUnit CRUD + Claim + State machine（读开放）' },
    { path: '/api/v1/workunits', router: workunitWriteRoutes, middleware: authNotGuest },
    { path: '/api/v1/requirements', router: requirementOpenRoutes, comment: 'REQ 需求编号体系 (vision §5.3；读开放)' },
    { path: '/api/v1/requirements', router: requirementWriteRoutes, middleware: authNotGuest },
    { path: '/api/v1/agent-profiles', router: agentProfileOpenRoutes, comment: 'AS-025 Phase 2: AgentProfile CRUD（读开放）' },
    { path: '/api/v1/agent-profiles', router: agentProfileWriteRoutes, middleware: authNotGuest },
    { path: '/api/v1/agent-instances', router: agentInstanceOpenRoutes, comment: 'AS-026 AC-1: RuntimeInstance CRUD（读开放）' },
    { path: '/api/v1/agent-instances', router: agentInstanceWriteRoutes, middleware: authNotGuest },
    { path: '/api/v1/agent-instances', router: agentInstanceAdminRoutes, middleware: admin, comment: 'terminate（原 requireAuth+requireAdmin，等价上移）' },
    { path: '/api/v1/triggers', router: triggerRouter, middleware: admin, comment: '3.28c-4: Trigger CRUD + status' },
    { path: '/api/v1/evolution', router: evolutionRoutes, middleware: admin, comment: 'E1 约束进化：提案列表/审批/手动扫描 (vision §6)' },
    { path: '/api/v1/monitoring', router: monitoringRoutes, middleware: admin, comment: 'MVP-2/6: Agent + WorkUnit monitoring' },
    { path: '/api/v1/projects', router: projectRoutes, middleware: auth, comment: 'AC-D1+D3: Local project discovery（登录即可：PMO 新建表单工程下拉依赖）' },

    // 能力与工具
    // 顺序约束②：skillDemotionOpenRoutes 必须先于 skillsOpenRoutes 挂载（见文件尾部 assertRouteOrder）。
    // 原因：skillsOpenRoutes 的 GET /:id 未命中时直接 404 不 next()，
    // 若 SkillHub 先挂载，GET /api/v1/skills/demotion-proposals 会被 :id='demotion-proposals' 吞掉，降级提案端点死路。
    { path: '/api/v1/skills/demotion-proposals', router: skillDemotionOpenRoutes, comment: '§10.6: skill 降级提案（先于 SkillHub 注册；读开放）' },
    { path: '/api/v1/skills/demotion-proposals', router: skillDemotionWriteRoutes, middleware: authNotGuest },
    { path: '/api/v1/skills', router: skillsOpenRoutes, comment: 'FL-025: SkillHub（读开放，含 /stats 被 /:id 遮蔽的历史顺序）' },
    { path: '/api/v1/skills', router: skillsWriteRoutes, middleware: authNotGuest },
    { path: '/api/v1/skills/proposals', router: skillProposalOpenRoutes },
    { path: '/api/v1/skills/proposals', router: skillProposalWriteRoutes, middleware: authNotGuest },

    // 运行时
    { path: '/api/v1/iron-laws', router: ironLawsRoutes, comment: 'Iron Laws (ex-runtime-proxy)' },
    { path: '/api/v1/events', router: sseRoutes, comment: 'HZ-028: Event Stream SSE' },
    { path: '/api/v1/events', router: eventOpenRoutes, middleware: auth, comment: 'G30: StudioEvent CRUD（读：登录即可）' },
    { path: '/api/v1/events', router: eventWriteRoutes, middleware: authNotGuest },
    { path: '/api/v1/transcripts', router: transcriptRoutes, middleware: auth, comment: '#174: WU transcript 只读查看（#60 C5）' },
    { path: '/api/v1/mcp', router: mcpRoutes, comment: '§12.9: MCP Server（localhost/admin/permission service 三态混合粒度，鉴权留路由内；rate limit via tool-registry）' },
    { path: '/api/v1/harness', router: harnessRoutes, middleware: admin, comment: 'T-015: Harness 监控集成' },
    { path: '/api/v1/cso', router: csoRoutes, comment: 'Decision #5: CSO 验证（无需认证；仅 csoRoutes，不再整挂 harness router）' },
    { path: '/api/v1/builtin-tools', router: builtinToolRoutes, middleware: admin, comment: 'HZ-026: Built-in Toolset' },

    // 文档与审查
    { path: '/api/v1/specs', router: specsRoutes.specsOpenRoutes, middleware: auth, comment: 'SP-002（读 + analyze-change：登录即可）' },
    { path: '/api/v1/specs', router: specsRoutes.specsWriteRoutes, middleware: authNotGuest, comment: 'SP-002 写（changes validate/import）' },

    // 通知与知识
    { path: '/api/v1/notifications', router: notificationRoutes, middleware: authNotGuest },
    { path: '/api/v1/action-center', router: actionCenterRoutes, middleware: authNotGuest, comment: '#468: 统一行动中心（状态派生 + 事件持久）' },
    { path: '/api/v1/notify', router: notifyRoutes, middleware: admin, comment: 'DD-009: 出站推送（内部调用）' },
    { path: '/api/v1/notify-channels', router: notifyChannelRoutes, middleware: admin, comment: '#525 P2-6: 通知渠道配置（企微 webhook + ClawBot 扫码绑定，/settings 配置区）' },
    { path: '/api/v1/knowledge', router: knowledgeRoutes, middleware: auth },
    { path: '/api/v1/knowledge-service', router: knowledgeServiceRoutes, middleware: auth, comment: 'KnowledgeService HTTP API + SSE' },
    { path: '/api/v1/review-proposals', router: reviewProposalOpenRoutes, middleware: auth, comment: '#351: 人审提案卡通用端点 status（只读，登录即可；distill/gc/audit/memory 经注册表分发；#353 起取代 /role-memory 专有端点）' },
    { path: '/api/v1/review-proposals', router: reviewProposalWriteRoutes, middleware: authNotGuest, comment: '#351: approve/reject（原路由内 requireNotGuest 等价上移）' },
    { path: '/api/knowledge', router: knowledgeInternalRoutes, middleware: localhost, comment: 'Internal knowledge extraction API (2026-07 收紧：本机回环限定，此前全匿名可写/盗用 LLM)' },
    { path: '/api/v1/library', router: libraryRoutes, comment: 'T5 #155: library 阅览室——跨项目 .studio/ 聚合只读层' },

    // 运维
    { path: '/api/v1/health', router: healthRoutes, comment: 'M1: Health check' },
    { path: '/api/v1/audit-logs', router: auditLogRoutes, middleware: admin, comment: 'AR-012' },
    { path: '/api/v1/admin/docs-freshness', router: docsFreshnessRoutes, middleware: admin, comment: 'T-020: CLAUDE.md 新鲜度检查' },

    // Discord
    { path: '/api/v1/discord', router: discordRoutes, comment: 'Discord Interactions' },

    // Deploy（触发式部署：GitHub push webhook，HMAC 校验，免登录见 app.ts PUBLIC_API）
    { path: '/api/v1/deploy', router: deployWebhookRoutes, comment: 'GitHub push webhook → auto-deploy' },

    // Workspace（AS-020 P2：只读查询 + 删除；token 管理已随 #481 退役——远程节点方向的纯残骸）
    { path: '/api/v1/workspaces', router: workspaceRoutes, middleware: admin, comment: 'AS-020: Workspace read-only + delete（P2-e：原路由内 requireAuth+requireAdmin 等价上移）' },

    // Lark (飞书)
    { path: '/api/v1/lark', router: larkRoutes, comment: '飞书机器人回调' },

    // DingTalk (钉钉)
    { path: '/api/v1/dingtalk', router: dingtalkRoutes, comment: '钉钉机器人回调' },
  ];

  // 启动断言（fail-fast）：两处顺序敏感注册约束，顺序被改动破坏时启动即报错，
  // 而不是上线后静默 404 / 路由错。约束原因见上方「顺序约束①/②」注释。
  assertRouteOrder(table, [
    {
      before: { path: '/api/v1/agents', router: tokenUsageRoutes },
      after: { path: '/api/v1/agents', router: agentRouters.agentOpenRoutes },
      reason: '§10.5: token-usage 聚合端点必须先于 legacy agent open 路由挂载，保证 /:id/token-usage 恒由 tokenUsageRoutes 接管。',
    },
    {
      before: { path: '/api/v1/skills/demotion-proposals', router: skillDemotionOpenRoutes },
      after: { path: '/api/v1/skills', router: skillsOpenRoutes },
      reason: '§10.6: skillsOpenRoutes 的 GET /:id 未命中直接 404，降级提案必须先于 SkillHub 挂载，否则端点被 :id 吞掉。',
    },
  ]);

  return table;
}
