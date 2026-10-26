/**
 * Route Registry - 模块化路由注册
 *
 * 每个条目描述一个 API 模块的路由配置。
 * 新增模块只需在此表中添加一行，无需修改 app.ts。
 */
import { Router as ExpressRouter, type Router } from 'express';
import { requireAuth, requireNotGuest, requireAdmin, requireLocalhost } from './middleware/auth.js';
import { mcpRateLimit } from './middleware/rate-limit.js';
import { logger } from '@dommaker/studio-shared/node';

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
 * 鉴权姿态五档（target-architecture.md §鉴权）。模块级共享数组——中间件是无状态闭包，
 * 提升出 buildRouteTable 后行为不变，且数组引用稳定 → describeEntryAuth 可按引用判别姿态。
 */
const AUTH = [requireAuth()];
// 2026-07 API 鉴权收紧（姿态 A：保持 Lurk Wall，收紧写操作+敏感信息，详见 docs/plans/2026-07-api-auth-tightening.md）
// P2-e 声明式统一：写端点通用姿态 = 登录 + 非 Guest；读开放的路由走 open entry（生产 Lurk Wall 兜底）。
const AUTH_NOT_GUEST = [requireAuth(), requireNotGuest()];
const ADMIN = [requireAuth(), requireAdmin()];
const LOCALHOST = [requireLocalhost()];

export type AuthPosture = 'open' | 'auth' | 'authNotGuest' | 'admin' | 'localhost';

/**
 * 协议面例外清单（#664 固化）：全仓 raw Express 路由（非 defineRoute）的完整集合。
 *
 * 口径：例外清单之外出现新 raw 路由 = 违规；例外被收编 defineRoute 后须同步从本表删除。
 * 机械守卫 = openapi/__tests__/openapi.probe.ts 断言「skipped 集合 ≡ 本表」（双向精确相等），
 * 与 OpenAPI `x-studio-undocumented` 同一数据源（discover 的 skipped 即本表路由）。
 *
 * 例外成立的唯一理由是「协议/运维面，defineRoute 的 JSON envelope 模型不适用」，
 * 业务面一律收编（knowledge/harness 已于 2026-10 批次 4/7 收编，不在此表）。
 */
export interface ProtocolSurfaceException {
  /** 大写方法（GET/POST），与 discover skipped.method 大小写无关比较 */
  method: string;
  /** 完整路径（含挂载前缀），与 discover skipped.path 对齐 */
  path: string;
  /** 例外原因（为什么 defineRoute 模型不适用） */
  reason: string;
}

export const PROTOCOL_SURFACE_EXCEPTIONS: readonly ProtocolSurfaceException[] = [
  // 事件流（HZ-028）：text/event-stream 长连接 + 手写 SSE 帧（id/data/heartbeat），非请求-响应壳
  { method: 'GET', path: '/api/v1/events/stream', reason: 'SSE 长连接流：defineRoute 的「返回数据包 envelope」模型不适用（res.writeHead + 持续写帧）' },
  { method: 'GET', path: '/api/v1/events/clients', reason: 'SSE 连接管理伴生调试端点，随 SSE 路由同进出' },
  // MCP 消息面（§12.9）：JSON-RPC over HTTP + SSE transport，自有协议壳
  { method: 'POST', path: '/api/v1/mcp', reason: 'MCP 协议端点：JSON-RPC 消息壳（jsonrpc/id/result|error），非 { data } envelope' },
  { method: 'GET', path: '/api/v1/mcp/sse', reason: 'MCP SSE transport：长连接协议通道' },
  { method: 'POST', path: '/api/v1/mcp/messages', reason: 'MCP SSE transport 消息回传：协议会话帧，非独立 REST 端点' },
  { method: 'GET', path: '/api/v1/mcp/external/sse', reason: '外部 MCP SSE transport：长连接协议通道' },
  { method: 'POST', path: '/api/v1/mcp/external/messages', reason: '外部 MCP SSE transport 消息回传：协议会话帧' },
  // 第三方回调：验签需 raw body / 响应形状由对方平台规定，非自有 envelope
  { method: 'POST', path: '/api/v1/discord/interactions', reason: 'Ed25519 验签需 express.raw 原始 body（app.ts 挂载）；响应形状由 Discord Interactions 协议规定' },
  { method: 'POST', path: '/api/v1/deploy/webhook', reason: 'HMAC-SHA256 验签（X-Hub-Signature-256）需 raw body；GitHub webhook 协议面' },
  // 运维探针：响应形状对外固定（监控消费），且带 5s timeout race 分支
  { method: 'GET', path: '/api/v1/health', reason: '健康探针：{ status, ... } 平铺壳对外固定（Uptime 消费方），503 降级分支不走统一错误壳' },
];

/**
 * 判别 entry 的鉴权姿态（OpenAPI 派生用）：entry.middleware 与模块级姿态数组同一引用即该档；
 * 无 middleware = open（含混合粒度留路由内的例外面，语义见各 entry 注释）。
 */
export function describeEntryAuth(entry: Pick<RouteEntry, 'middleware'>): AuthPosture {
  const mw = entry.middleware;
  if (!mw || mw.length === 0) return 'open';
  if (mw === AUTH) return 'auth';
  if (mw === AUTH_NOT_GUEST) return 'authNotGuest';
  if (mw === ADMIN) return 'admin';
  if (mw === LOCALHOST) return 'localhost';
  // 兜底：非共享数组的自定义组合（当前不存在，防御未来绕过姿态声明直挂 middleware）
  return 'open';
}

/**
 * 构建完整路由表（延迟加载，避免循环依赖）
 */
export async function buildRouteTable(): Promise<RouteEntry[]> {
  const [
    auditLogRoutes,
    { notificationRoutes },
    { knowledgeRoutes, knowledgeInternalRoutes },
    pmoRouters,
    specsRoutes,
    notifyRoutes,
    authRoutes,
    discordRoutes,
    { deployWebhookRoutes },
  ] = await Promise.all([
    import('./modules/audit-logs/routes.js').then(m => m.default),
    import('./modules/notifications/routes.js') as Promise<{ notificationRoutes: Router }>,
    import('./modules/knowledge/routes/routes.js') as Promise<{ knowledgeRoutes: Router; knowledgeInternalRoutes: Router }>,
    import('./modules/pmo/routes.js'),
    import('./modules/specs/routes.js'),
    import('./modules/notifications/outbound-notify.routes.js').then(m => m.default),
    import('./modules/auth/routes.js').then(m => m.default),
    import('./modules/discord/routes.js').then(m => m.default),
    import('./modules/deploy/webhook.routes.js') as Promise<{ deployWebhookRoutes: Router }>,
  ]);

  // SkillHub routes (FL-025)——P2-e 拆 open/write 双 router（鉴权挂 registry entry）
  // P4.3：skill-demotion-routes / skill-proposal-routes 整文件随孤儿端点删除，
  // 原「先于 SkillHub 挂载防 /:id 遮蔽」的顺序约束随之退役（/:id 本身已删）
  const { skillsOpenRoutes, skillsWriteRoutes } = await import('./modules/skills/routes.js');

  // Company routes (FileStore 存储；PMO 页 / Settings 依赖)
  const { default: companyRoutes } = await import('./modules/companies/routes.js') as { default: Router };

  // KnowledgeService HTTP API + SSE
  const { knowledgeServiceRoutes, initKnowledgeEventBridge } = await import('./modules/knowledge/routes/knowledge-service.routes.js') as { knowledgeServiceRoutes: Router; initKnowledgeEventBridge: () => void };
  initKnowledgeEventBridge();

  // MCP routes (§12.9: 系统能力 MCP 化)
  const { default: mcpRoutes } = await import('./modules/mcp/routes.js') as { default: Router };

  // Event Stream SSE routes (HZ-028)
  const { default: sseRoutes } = await import('./modules/events/sse.routes.js') as { default: Router };

  // StudioEvent CRUD routes (G30)
  const { eventOpenRoutes, eventWriteRoutes } = await import('./modules/events/event.routes.js');

  // Runtime 事件回调（自 executions 模块迁入，POST /api/v1/executions/events URL 不变）
  const { default: runtimeEventRoutes } = await import('./modules/events/runtime-events.routes.js') as { default: Router };

  // Action Center routes (#468 统一行动中心)
  const { actionCenterRoutes } = await import('./modules/action-center/routes.js') as { actionCenterRoutes: Router };

  // WU transcript 只读查看 (#174, #60 C5)
  const { default: transcriptRoutes } = await import('./modules/transcripts/transcript.routes.js') as { default: Router };

  // Harness monitoring routes (T-015)
  const { default: harnessRoutes } = await import('./modules/harness/routes.js') as { default: Router };

  // CSO 验证子路由（2026-07 收紧：/api/v1/cso 只挂 validate，不再整挂 harness router——否则 /harness 的 Admin 收紧可被 /cso/* 双挂载绕过）
  const { csoRoutes } = await import('./modules/harness/cso.routes.js') as { csoRoutes: Router };

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
          const { createOpsService } = await import('./modules/ops/index.js');
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

  // RuntimeInstance terminate（AS-026 AC-1；Phase 4 批5：管理面 4 条孤儿端点已删，
  // agent-instance.service 由 ops/agent-loop 直调，不经 HTTP）
  const { agentInstanceAdminRoutes } = await import('./modules/agents/agent-instance.routes.js');

  // Trigger routes (3.28c-4: REST API for trigger management)
  const { triggerRouter } = await import('./modules/triggers/trigger.routes.js') as { triggerRouter: Router };

  // Monitoring routes (MVP-2 + MVP-6)（#683 起归 ops 模块）
  const { default: monitoringRoutes } = await import('./modules/ops/monitoring.routes.js') as { default: Router };

  // Project Discovery routes (AC-D1+D3: local project scanning)
  const { default: projectRoutes } = await import('./modules/projects/project.routes.js') as { default: Router };

  // #525 P2-6: 通知渠道配置（/settings「通知渠道」配置区，消费方 = notifyAlert 告警外推）
  const { default: notifyChannelRoutes } = await import('./modules/notifications/channels/routes.js') as { default: Router };

  const auth = AUTH;
  const authNotGuest = AUTH_NOT_GUEST;
  const admin = ADMIN;
  const localhost = LOCALHOST;

  const table: RouteEntry[] = [
    // 认证
    // 认证面本体：login/register/status 公开（PUBLIC_API）与 logout/admin 混合粒度是本质，鉴权留路由内
    { path: '/api/v1/auth', router: authRoutes, comment: 'SEC-001: 认证系统（混合粒度，不上移）' },

    // 核心业务
    // runtime 事件回调（events 模块；POST /events 路由内 legacy localhost / Agent 服务身份，粒度混合不上移）
    { path: '/api/v1/executions', router: runtimeEventRoutes, comment: 'agent-runtime 事件回调（自 executions 模块迁入，URL 不变）' },

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
    { path: '/api/v1/agent-instances', router: agentInstanceAdminRoutes, middleware: admin, comment: 'terminate（Phase 4 批5 后唯一活端点；原 requireAuth+requireAdmin，等价上移）' },
    { path: '/api/v1/triggers', router: triggerRouter, middleware: admin, comment: '3.28c-4: Trigger costs + fire（Phase 4 批5 后仅剩两个活端点）' },
    { path: '/api/v1/monitoring', router: monitoringRoutes, middleware: admin, comment: 'MVP-2/6: Agent + WorkUnit monitoring' },
    { path: '/api/v1/projects', router: projectRoutes, middleware: auth, comment: 'AC-D1+D3: Local project discovery（登录即可：PMO 新建表单工程下拉依赖）' },

    // 能力与工具
    // P4.3：/api/v1/skills 面只剩 GET /、GET /manifest（open）+ POST /:id/retract/decide（write），
    // 原 /:id 参数路由已删，demotion-proposals / proposals 先于 SkillHub 挂载的防遮蔽约束随之退役。
    { path: '/api/v1/skills', router: skillsOpenRoutes, comment: 'FL-025: SkillHub（读开放；P4.3 后剩 GET / 与 GET /manifest）' },
    { path: '/api/v1/skills', router: skillsWriteRoutes, middleware: authNotGuest },

    // 运行时
    { path: '/api/v1/events', router: sseRoutes, comment: 'HZ-028: Event Stream SSE（协议面例外，固化于 PROTOCOL_SURFACE_EXCEPTIONS）' },
    { path: '/api/v1/events', router: eventOpenRoutes, middleware: auth, comment: 'G30: StudioEvent CRUD（读：登录即可）' },
    { path: '/api/v1/events', router: eventWriteRoutes, middleware: authNotGuest },
    { path: '/api/v1/transcripts', router: transcriptRoutes, middleware: auth, comment: '#174: WU transcript 只读查看（#60 C5）' },
    { path: '/api/v1/mcp', router: mcpRoutes, comment: '§12.9: MCP Server（localhost/admin/permission service 三态混合粒度，鉴权留路由内；rate limit via tool-registry；消息面为协议面例外，固化于 PROTOCOL_SURFACE_EXCEPTIONS）' },
    { path: '/api/v1/harness', router: harnessRoutes, middleware: admin, comment: 'T-015: Harness 监控集成' },
    { path: '/api/v1/cso', router: csoRoutes, comment: 'Decision #5: CSO 验证（无需认证；仅 csoRoutes，不再整挂 harness router）' },

    // 文档与审查
    { path: '/api/v1/specs', router: specsRoutes.specsOpenRoutes, middleware: auth, comment: 'SP-002（读 + analyze-change：登录即可）' },
    { path: '/api/v1/specs', router: specsRoutes.specsWriteRoutes, middleware: authNotGuest, comment: 'SP-002 写（changes validate/import）' },

    // 通知与知识
    { path: '/api/v1/notifications', router: notificationRoutes, middleware: authNotGuest },
    { path: '/api/v1/action-center', router: actionCenterRoutes, middleware: authNotGuest, comment: '#468: 统一行动中心（状态派生 + 事件持久）' },
    { path: '/api/v1/notify', router: notifyRoutes, middleware: admin, comment: 'DD-009: 出站推送（内部调用）' },
    { path: '/api/v1/notify-channels', router: notifyChannelRoutes, middleware: admin, comment: '#525 P2-6: 通知渠道配置（企微 webhook + ClawBot 扫码绑定，/settings 配置区）' },
    { path: '/api/v1/knowledge', router: knowledgeRoutes, middleware: auth, comment: '知识条目/检索（2026-10 批次 4/7 收编 defineRoute；P4.2 删孤儿 8 端点后剩 gaps/:type·unified·resolutions·search·maintenance/run，#664 验证全覆盖）' },
    { path: '/api/v1/knowledge-service', router: knowledgeServiceRoutes, middleware: auth, comment: 'KnowledgeService HTTP API + SSE' },
    { path: '/api/v1/review-proposals', router: reviewProposalOpenRoutes, middleware: auth, comment: '#351: 人审提案卡通用端点 status（只读，登录即可；distill/gc/audit/memory 经注册表分发；#353 起取代 /role-memory 专有端点）' },
    { path: '/api/v1/review-proposals', router: reviewProposalWriteRoutes, middleware: authNotGuest, comment: '#351: approve/reject（原路由内 requireNotGuest 等价上移）' },
    { path: '/api/knowledge', router: knowledgeInternalRoutes, middleware: localhost, comment: 'Internal knowledge extraction API (2026-07 收紧：本机回环限定，此前全匿名可写/盗用 LLM)' },
    { path: '/api/v1/library', router: libraryRoutes, comment: 'T5 #155: library 阅览室——跨项目 .studio/ 聚合只读层' },

    // 运维
    { path: '/api/v1/health', router: healthRoutes, comment: 'M1: Health check（运维探针面例外，固化于 PROTOCOL_SURFACE_EXCEPTIONS）' },
    { path: '/api/v1/audit-logs', router: auditLogRoutes, middleware: admin, comment: 'AR-012' },

    // Discord（协议面例外：Ed25519 raw body 验签，固化于 PROTOCOL_SURFACE_EXCEPTIONS）
    { path: '/api/v1/discord', router: discordRoutes, comment: 'Discord Interactions（协议面例外，固化于 PROTOCOL_SURFACE_EXCEPTIONS）' },

    // Deploy（触发式部署：GitHub push webhook，HMAC 校验，免登录见 app.ts PUBLIC_API）
    { path: '/api/v1/deploy', router: deployWebhookRoutes, comment: 'GitHub push webhook → auto-deploy（协议面例外：HMAC raw body 验签，固化于 PROTOCOL_SURFACE_EXCEPTIONS）' },

    // Workspace（AS-020 P2：只读查询 + 删除；token 管理已随 #481 退役——远程节点方向的纯残骸）
    { path: '/api/v1/workspaces', router: workspaceRoutes, middleware: admin, comment: 'AS-020: Workspace read-only（P2-e：原路由内 requireAuth+requireAdmin 等价上移；P4.6 删 DELETE /:id 与 /:id/runtimes）' },
  ];

  // 启动断言（fail-fast）：顺序敏感注册约束，顺序被改动破坏时启动即报错，
  // 而不是上线后静默 404 / 路由错。
  // P4.3：skills 域的 assertRouteOrder 约束随 demotion-proposals / proposals 挂载退役
  // （/:id 参数路由已删，遮蔽前提不复存在）；表内其余顺序约束如有新增在此登记。
  assertRouteOrder(table, []);

  return table;
}
