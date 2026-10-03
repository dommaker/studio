/**
 * WorkUnit API 路由 (AS-025 §3.28c-1, §5.16) —— 契约驱动版（首个迁移域）。
 *
 * Endpoints:
 *   GET    /api/v1/workunits          — list（#109：列表项附 claimable 可认领标记；D-2 项4：q= 标题子串搜索）
 *   GET    /api/v1/workunits/last-done — 批量最近完成（#387：每 assignee 一条 done/completed，roster 空闲卡用）
 *   POST   /api/v1/workunits          — create
 *   GET    /api/v1/workunits/:id      — get by id
 *   PUT    /api/v1/workunits/:id      — update
 *   DELETE /api/v1/workunits/:id      — delete
 *   POST   /api/v1/workunits/:id/claim   — claim（flock 悲观互斥锁）
 *   POST   /api/v1/workunits/:id/unclaim — unclaim
 *   POST   /api/v1/workunits/:id/status  — transition status (state machine)
 *   POST   /api/v1/workunits/:id/review-passed   — review approved (in_review → done)
 *   POST   /api/v1/workunits/:id/review-rejected — review rejected (in_review → active/blocked)
 *   POST   /api/v1/workunits/:id/verify          — F6-c 断点 2：人工重跑 L1 自动验证（human-only，不动状态）
 *   POST   /api/v1/workunits/:id/dispatch-review — F6-c 断点 3：人工补派 agent 评审（human-only）
 *   POST   /api/v1/workunits/:id/opportunities/:oppId/adopt  — #163 巡检机会采纳（建 feature 子单）
 *   POST   /api/v1/workunits/:id/opportunities/:oppId/ignore — #163 巡检机会忽略（终态，可附理由）
 *   POST   /api/v1/workunits/:id/resume — #185（决策 #87 D2）：Web 按钮通道「继续执行」（与回复路径共享复活原语）
 *   POST   /api/v1/workunits/:id/close  — #185（决策 #87 D2）：Web 按钮通道「关闭任务」（死信显式关闭路径）
 *   POST   /api/v1/workunits/:id/ruling — #467：裁决轮一次性提交（采纳/打回重议；批量落探路台账 + 复活同会话）
 *   POST   /api/v1/workunits/:id/direction — #567：方向锁定提交（选定方向落探路台账 + 复活同会话）
 *
 * 涌现路径 (AS-025 §5.15):
 *   POST   /api/v1/workunits/from-message — convert ChannelMessage to WorkUnit
 *
 * 讨论空间 (AS-025 §5.16):
 *   GET    /api/v1/workunits/:id/messages       — list messages by workUnitId
 *   POST   /api/v1/workunits/:id/messages       — send message (auto-associate workUnitId)
 *   PATCH  /api/v1/workunits/:id/messages/:messageId — edit message
 *
 * 契约驱动（docs/architecture/target-architecture.md）：全部端点走 core/http.ts defineRoute——
 * zod schema（@dommaker/studio-contract workunit 域）校验入参，成功统一 `{ data }` / 分页壳，
 * 错误映射表（原 http-helpers.ts WORKUNIT_ERROR_MAPS，逐端点搬入 options.errors）+
 * HttpError 直出。human-only 守卫 = core/http.ts requireHuman 中间件。
 * verify 业务下沉 WorkUnitService.verifyManually（判别联合 kind → 本层只映射 kind → 响应）。
 */

import { Router, type Request } from 'express';

import {
  listWorkUnitsQuerySchema,
  createWorkUnitBodySchema,
  updateWorkUnitBodySchema,
  fromMessageBodySchema,
  lastDoneQuerySchema,
  changedFilesQuerySchema,
  wuIdParamsSchema,
  opportunityParamsSchema,
  messageParamsSchema,
  listMessagesQuerySchema,
  claimBodySchema,
  transitionStatusBodySchema,
  reviewPassedBodySchema,
  reviewRejectedBodySchema,
  verifyBodySchema,
  planRulingPayloadSchema,
  planDirectionPayloadSchema,
  ignoreOpportunityBodySchema,
  postMessageBodySchema,
  patchMessageBodySchema,
} from '@dommaker/studio-contract';
import { WorkUnitService, type WorkUnitData } from './workunit.service.js';
import type { CreateWorkUnitInput, UpdateWorkUnitInput } from './workunit-crud.js';
import type { WorkUnitMetadata } from './workunit.types.js';
import { parseWuMetadata } from './wu-metadata.js';
import { resolveClaimable, buildStatusById } from './wu-dependencies.js';
import { adoptInspectionOpportunity, ignoreInspectionOpportunity } from './inspection-opportunities.js';
import { resolveReviewConfirm, ConfirmPayloadError } from './confirm-payload.js';
// P2-c 拆环：aggregateTreeTokens 转路由处理器内动态 import（workunit→agents 静态边清零）
import type { MessageMeta } from '../channels/index.js';
// P2-c 拆环：channelMessageService 值引用转处理器内动态 import（workunit→channels 静态边清零）
import { resumeBlockedWorkUnitFromWeb, closeBlockedWorkUnitFromWeb } from './waiting-input.js';
// P2-c 拆环：plan ruling/direction 应用函数与错误类转路由处理器内动态 import
// （errors 映射改处理器内 try/catch 等价实现；workunit→pmo 静态边清零）
import { claimWorkUnitAndAnnounce } from './claim-announce.js';
import { listWorkUnitsChangedFiles } from './wu-changed-files.js';
import { parsePagination } from '../../utils/pagination.js';
import { type AuthRequest } from '../../middleware/auth.js';
import { defineRoute, paginated, HttpError, requireHuman } from '../../core/http.js';
import { getStore } from '../../core/store.js';


// P2-e 鉴权声明式统一：读（open，生产 Lurk Wall 兜底）/ 写（registry 挂 authNotGuest）拆 router，
// 路由内不再挂 requireAuth/requireNotGuest；requireHuman 守卫（authorType=agent 拒绝）非鉴权声明，保留路由内。
const openRoutes = Router();
const writeRoutes = Router();
const service = new WorkUnitService(getStore());
// #387: 单次批量 id 上限（调用方单页规模 ≤ 数十，留余量；超出静默截断）
const MAX_BATCH_IDS = 100;

/** human-only 端点的 403 文案（A2A §4.4-2，沿用原内联守卫措辞） */
const REVIEW_HUMAN_ONLY = 'Review actions are human-only (authorType=agent rejected)';

/** getById 或抛 404——各端点「WU 必须存在」前置守卫的统一写法 */
async function mustGetWu(id: string): Promise<WorkUnitData> {
  const wu = await service.getById(id);
  if (!wu) throw new HttpError(404, 'NOT_FOUND', `WorkUnit ${id} not found`);
  return wu;
}

/** requireAuth 后取署名（本地模式回落 Local User/id），review/verify 落台账 by 字段共用 */
function callerName(req: Request): string {
  const user = (req as AuthRequest).user;
  return user?.name ?? user?.email ?? user?.id ?? 'human';
}

/** GET / — list WorkUnits */
openRoutes.get('/', defineRoute(
  { query: listWorkUnitsQuerySchema },
  async (req, _res, input) => {
    const { type, status, assigneeId, channelId, parentId, attributed, projectId, q } = input.query;
    const { page, limit } = parsePagination(req);

    const result = await service.list({
      type,
      status,
      assigneeId,
      channelId,
      parentId,
      // #428：attributed=true/false 显式布尔；其他值（含缺省）= undefined 不过滤
      attributed: attributed === 'true' ? true : attributed === 'false' ? false : undefined,
      // #456：PMO 项目归属过滤（空串不过滤）
      projectId: projectId ? projectId : undefined,
      // 批次 D-2 项4：标题搜索（scope 子串，大小写不敏感）；空白 q 不过滤
      q: q?.trim() ? q.trim() : undefined,
      page,
      limit,
    });

    // #109：列表项附「可认领」标记（claimable）供 UI 使用 —— unassigned 且
    // blockedBy 依赖全了结才为 true；profile 无关（认领侧仍由 loop observe 判定）。
    // 仅当本页含 unassigned 行才读 index 做依赖判定（其余行 claimable 恒 false）
    const statusById = result.data.some(w => w.status === 'unassigned')
      ? buildStatusById(await getStore().getIndex())
      : new Map<string, string>();
    const data = result.data.map(w => ({ ...w, claimable: resolveClaimable(w, statusById) }));

    return paginated(data, { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) });
  },
));

/** POST / — create WorkUnit */
writeRoutes.post('/', defineRoute(
  { body: createWorkUnitBodySchema },
  { status: 201 },
  async (_req, _res, input) =>
    // schema 已剥壳收字段（8 键，同原手工解构）；metadata 形状 = WorkUnitMetadata 的超集 Record
    service.create(input.body as CreateWorkUnitInput),
));

/** POST /from-message — convert ChannelMessage to WorkUnit (emergence path) */
writeRoutes.post('/from-message', defineRoute(
  { body: fromMessageBodySchema },
  {
    status: 201,
    errors: [
      { match: 'not found', status: 404, code: 'NOT_FOUND' },
      { match: 'already linked', status: 409, code: 'ALREADY_CONVERTED' },
    ],
  },
  async (_req, _res, input) => {
    const { messageId, type, metadata, channelId } = input.body;
    // #524 P1-1：body.channelId 可选透传 → 按频道直查，免全频道扫描反查（空串 = 缺省）
    return service.createFromMessage(messageId, {
      type,
      metadata: metadata as WorkUnitMetadata | undefined,
      channelId: channelId ? channelId : undefined,
    });
  },
));

/**
 * GET /last-done?assigneeIds=a,b,c — #387 批量聚合：每 assignee 最近一条完成 WU
 * （done/completed，completedAt ?? updatedAt 降序取首条；无完成记录 → null）。
 * roster 空闲卡「最近完成」专用，消逐实例 GET /workunits?assigneeId= 的 N+1。
 */
openRoutes.get('/last-done', defineRoute(
  { query: lastDoneQuerySchema },
  async (_req, _res, input) => {
    const ids = input.query.assigneeIds.split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (ids.length === 0) {
      throw new HttpError(400, 'INVALID_INPUT', 'assigneeIds is required (comma-separated ids)');
    }
    return service.lastDoneByAssignee(ids.slice(0, MAX_BATCH_IDS));
  },
));

/**
 * GET /changed-files?ids=a,b,c — #285 AC4 批量版（2026-09-25 频道首屏合并）：
 * 一次 30d 窗口读派生全部 WU 的文件集，替代前端逐 WU 单发（每次各自全窗口扫描）。
 * 空 ids → 空映射；单项无数据/整体读取失败 → 该 WU 空数组（chip 降级候选集词表）。
 * 须注册在 /:id 之前（同 /last-done 先例）。只读，匿名公开（与 GET /:id/changed-files 同口径）。
 */
openRoutes.get('/changed-files', defineRoute(
  { query: changedFilesQuerySchema },
  async (_req, _res, input) => {
    const ids = (input.query.ids ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0);
    const filesByWu = await listWorkUnitsChangedFiles(ids.slice(0, MAX_BATCH_IDS));
    return { filesByWu };
  },
));

/** GET /:id — get WorkUnit by id */
openRoutes.get('/:id', defineRoute(
  { params: wuIdParamsSchema },
  async (_req, _res, input) => mustGetWu(input.params.id),
));

/** PUT /:id — update WorkUnit */
writeRoutes.put('/:id', defineRoute(
  { params: wuIdParamsSchema, body: updateWorkUnitBodySchema },
  { errors: [{ match: 'not found', status: 404, code: 'NOT_FOUND' }] },
  // metadata/日期字段的 service 侧类型（WorkUnitMetadata/Date）与 wire 形状不同构，边界处一次性断言
  async (_req, _res, input) => service.update(input.params.id, input.body as unknown as UpdateWorkUnitInput),
));

/**
 * #163（T8-E2，#130 决策 6）：巡检机会采纳——建 feature 子单（显式 unassigned 进
 * frontier，采纳动作即人工闸），源条目记 wuId。机制在 inspection-opportunities.ts。
 */
const OPPORTUNITY_ERRORS = [
  { match: 'not found', status: 404, code: 'NOT_FOUND' },
  { match: 'already resolved', status: 409, code: 'INVALID_STATE' },
  { match: 'not an inspection', status: 409, code: 'INVALID_STATE' },
] as const;

writeRoutes.post('/:id/opportunities/:oppId/adopt', defineRoute(
  { params: opportunityParamsSchema },
  { status: 201, errors: OPPORTUNITY_ERRORS },
  async (_req, _res, input) => adoptInspectionOpportunity(service, input.params.id, input.params.oppId),
));

/** #163（T8-E2）：巡检机会忽略——终态，可附理由（body.reason，下轮巡检不重复上报的判据） */
writeRoutes.post('/:id/opportunities/:oppId/ignore', defineRoute(
  { params: opportunityParamsSchema, body: ignoreOpportunityBodySchema },
  { errors: OPPORTUNITY_ERRORS },
  async (_req, _res, input) =>
    ignoreInspectionOpportunity(service, input.params.id, input.params.oppId, input.body.reason),
));

/** GET /:id/tree-tokens - 树级 token 开销聚合（AC-5.4, §8.4.4） */
openRoutes.get('/:id/tree-tokens', defineRoute(
  { params: wuIdParamsSchema },
  async (_req, _res, input) => {
    const wu = await mustGetWu(input.params.id);
    const meta = parseWuMetadata(wu.metadata);
    const rootId = meta.collab?.rootId ?? wu.id;
    // P2-c 拆环：workunit→agents 静态边转函数内动态 import
    const { aggregateTreeTokens } = await import('../agents/index.js');
    return aggregateTreeTokens(rootId, getStore());
  },
));

/** DELETE /:id — delete WorkUnit */
writeRoutes.delete('/:id', defineRoute(
  { params: wuIdParamsSchema },
  {
    status: 204,
    errors: [
      { match: 'not found', status: 404, code: 'NOT_FOUND' },
      { match: 'Record to delete does not exist', status: 404, code: 'NOT_FOUND' },
    ],
  },
  async (_req, _res, input) => {
    await service.delete(input.params.id);
    return undefined;
  },
));

/** POST /:id/claim — claim WorkUnit（flock 悲观互斥锁）；#445：认领即发声原语接入（与 loop 自动认领同路径） */
writeRoutes.post('/:id/claim', defineRoute(
  { params: wuIdParamsSchema, body: claimBodySchema },
  { errors: [{ match: 'Claim failed', status: 409, code: 'CLAIM_FAILED' }] },
  async (req, _res, input) => {
    // #445：agentId 可省略——缺省 = 当前登录用户（人工引导片认领，身份诚实归因会话用户）；
    // 显式传入保持旧契约（认领给指定 id）。requireAuth 保证 req.user 存在（none 模式注入 local）。
    const bodyAgentId = input.body.agentId;
    const claimerId = bodyAgentId ?? req.user?.id;
    if (!claimerId) {
      throw new HttpError(400, 'INVALID_INPUT', 'agentId is required');
    }
    // 发声署名：人工认领署用户显示名；显式 agentId 旧契约无法廉价解析角色名 → 退化为 id
    const claimerName = bodyAgentId ?? req.user?.name ?? req.user?.email ?? claimerId;

    return claimWorkUnitAndAnnounce(input.params.id, claimerId, claimerName, { wuService: service, fileStore: getStore() });
  },
));

/** POST /:id/unclaim — unclaim WorkUnit */
writeRoutes.post('/:id/unclaim', defineRoute(
  { params: wuIdParamsSchema },
  { errors: [{ match: 'not found', status: 404, code: 'NOT_FOUND' }] },
  async (_req, _res, input) => service.unclaim(input.params.id),
));

/** POST /:id/review-passed — review approved (in_review → done) */
writeRoutes.post('/:id/review-passed', requireHuman(REVIEW_HUMAN_ONLY), defineRoute(
  { params: wuIdParamsSchema, body: reviewPassedBodySchema },
  {
    errors: [
      { match: ConfirmPayloadError, status: 400, code: 'INVALID_CONFIRM' },
      { match: 'not found', status: 404, code: 'NOT_FOUND' },
      { match: 'Cannot review', status: 400, code: 'INVALID_TRANSITION' },
    ],
  },
  async (req, _res, input) => {
    // F6（决策 1）：人工确认落台账 l3 —— by 取登录用户名（本地模式回落 Local User/id）
    // #110：可选 body.summary（人点通过时填写的结论文本）穿透进 l3 台账——
    // pmo/decision-resolution 订阅器据此把 decision 单结论原样写入探路地图 decisions[]
    // #463：可选 body.confirm 结构化评审表单（decision/spec/analysis）——后端序列化为
    // l3.summary（存储契约不变，人不接触魔法行）；与裸 summary 并存时 confirm 优先；
    // analysis 的 tasks 经 options.analysisTasks 透传覆写 metadata.analysisTasks。
    const confirm = resolveReviewConfirm(input.body.confirm);
    const rawSummary = input.body.summary;
    const summary = confirm.summary
      ?? (typeof rawSummary === 'string' && rawSummary.trim() ? rawSummary : undefined);
    // #177：可选 defaultAssigneeId（profile id）——analysis 确认处「默认执行角色」，
    // 落 WU metadata.defaultTaskAssigneeId，analysis-handoff 应用于全部派生 task 子 WU
    const defaultAssigneeId = input.body.defaultAssigneeId;
    const options = {
      ...(typeof defaultAssigneeId === 'string' && defaultAssigneeId.trim()
        ? { defaultTaskAssigneeId: defaultAssigneeId.trim() } : {}),
      ...(confirm.analysisTasks !== undefined ? { analysisTasks: confirm.analysisTasks } : {}),
    };
    return service.reviewPassed(input.params.id, {
      by: callerName(req),
      kind: 'human-confirm',
      ...(summary ? { summary } : {}),
    }, Object.keys(options).length > 0 ? options : undefined);
  },
));

/** POST /:id/review-rejected — review rejected (in_review → active, or blocked after 3) */
writeRoutes.post('/:id/review-rejected', requireHuman(REVIEW_HUMAN_ONLY), defineRoute(
  { params: wuIdParamsSchema, body: reviewRejectedBodySchema },
  {
    errors: [
      { match: 'not found', status: 404, code: 'NOT_FOUND' },
      { match: 'Cannot review', status: 400, code: 'INVALID_TRANSITION' },
    ],
  },
  // F6（决策 1）：人工否决同样落台账 l3（rejected 留痕）
  async (req, _res, input) => service.reviewRejected(input.params.id, input.body.reason, {
    by: callerName(req),
    kind: 'human-confirm',
  }),
));

/**
 * POST /:id/verify — F6-c（断点 2）：人工重跑 L1 自动验证（human-only，验收权只在人同 A2A §4.4）。
 * 仅代码类 WU（task/bug/feature/refactor）且有 worktree 落档；body.commands 可选
 * （传了视为 metadata.verifyCommands 覆盖）。只补写台账 l1/verifyReport，不动 WU status；
 * 写完发 status_changed（状态值不变也发）让 pmo rollup 按证据齐备度重估。
 * #551：业务下沉 WorkUnitService.verifyManually（脱 HTTP 可直测），本层只映射 kind → 响应。
 * no-commands 是 422 业务结果（非异常），handler 自写响应（同样包 { data } 壳）。
 */
writeRoutes.post('/:id/verify', requireHuman('Verify actions are human-only (authorType=agent rejected)'), defineRoute(
  { params: wuIdParamsSchema, body: verifyBodySchema },
  async (req, res, input) => {
    const bodyCommands = (input.body.commands ?? []).filter(c => c.trim().length > 0);
    const result = await service.verifyManually(input.params.id, {
      by: callerName(req),
      ...(bodyCommands.length > 0 ? { commands: bodyCommands } : {}),
    });
    switch (result.kind) {
      case 'not-found':
        throw new HttpError(404, 'NOT_FOUND', `WorkUnit ${input.params.id} not found`);
      case 'not-code-type':
        throw new HttpError(400, 'INVALID_INPUT', `仅代码类 WU（task/bug/feature/refactor）支持 L1 验证（当前 type=${result.wuType}）`);
      case 'no-worktree':
        throw new HttpError(409, 'NO_WORKTREE', 'WU 无 worktree 落档（metadata.worktreePath 为空），无法验证');
      case 'no-commands':
        res.status(422).json({
          data: {
            verified: false,
            reason: 'no-commands',
            hint: '请在 WU metadata.verifyCommands 或 worktree 的 package.json scripts(test/typecheck/lint)中配置验证命令',
          },
        });
        return undefined;
      case 'failed':
        return { verified: false, failed: [result.failure] };
      case 'verified':
        return { verified: true, report: result.report };
    }
  },
));

/**
 * POST /:id/dispatch-review — F6-c（断点 3）：人工补派 agent 评审（human-only）。
 * 父 WU 被人工直推 done（或 in_review 但评审子 WU 缺失）时补建 review 子 WU，
 * 走与 ReviewDispatcher 路径 A 相同的未指派涌现 + excludeAssignee/自评兜底逻辑。
 */
writeRoutes.post('/:id/dispatch-review', requireHuman(REVIEW_HUMAN_ONLY), defineRoute(
  { params: wuIdParamsSchema },
  {
    errors: [
      { match: 'not found', status: 404, code: 'NOT_FOUND' },
      { match: 'already', status: 409, code: 'ALREADY_SATISFIED' },
      { match: 'Cannot dispatch', status: 400, code: 'INVALID_INPUT' },
      { match: 'not reviewable', status: 400, code: 'INVALID_INPUT' },
      { match: 'no channel', status: 400, code: 'INVALID_INPUT' },
    ],
  },
  async (_req, _res, input) => {
    // 与 index.ts 启动时同款动态 import：避免路由模块加载时拉起整个 agents 模块图
    const { getReviewDispatcher } = await import('../agent-loop/index.js') as typeof import('../agent-loop/index.js');
    const child = await getReviewDispatcher().dispatchReviewNow(input.params.id);
    return { reviewWorkUnitId: child.id };
  },
));

/**
 * POST /:id/resume — #185（决策 #87 D2）：Web 按钮通道「继续执行」（纯授权复活，human-only）。
 * 与频道回复路径共享同一复活原语（重置 consecutiveStuck/blockReason、记 resumeCount、
 * timeoutReleaseCount 终身保留），pendingReplies 注入固定占位文案；复活后发 Studio 系统消息里程碑。
 * 分类型显示是 UI 层决策（D3），端点不设类型门槛；归属等待型按回复语义不被纯授权复活 → 409。
 */
writeRoutes.post('/:id/resume', defineRoute(
  { params: wuIdParamsSchema },
  async (_req, _res, input) => {
    const wu = await mustGetWu(input.params.id);
    if (wu.status !== 'blocked') {
      throw new HttpError(409, 'NOT_BLOCKED', `WorkUnit 当前状态为 ${wu.status}，仅 blocked 可继续执行`);
    }
    const resumed = await resumeBlockedWorkUnitFromWeb(input.params.id, getStore());
    if (!resumed) {
      throw new HttpError(409, 'RESUME_REJECTED', '复活未完成（等待工程归属的任务请在频道回复工程名或路径）');
    }
    return service.getById(input.params.id);
  },
));

/**
 * POST /:id/ruling — #467：裁决轮一次性提交（human-only，结构化表单通道）。
 * plan 会话 fog 调研齐后出一次裁决卡（NEED_INPUT + RULING 行 → metadata.planRulings）；
 * 人一次操作（全对 / 单题修改 / 某题打回重议）经本端点提交：applyPlanRuling 批量落探路台账
 * （decisions[] + fog resolved/open）+ 组合裁决结果文本复活同会话（pendingReplies 注入）。
 * 前置守卫：仅 blocked 且 metadata.planRulings 非空（裁决轮挂起中）；载荷非法 → 400。
 */
writeRoutes.post('/:id/ruling', defineRoute(
  { params: wuIdParamsSchema, body: planRulingPayloadSchema },
  async (_req, _res, input) => {
    // P2-c 拆环：动态 import + try/catch 等价原 errors 映射（PlanRulingError → 400 INVALID_RULING）
    const { applyPlanRuling, validateRulingItems, PlanRulingError } = await import('../pmo/index.js');
    try {
      const wu = await mustGetWu(input.params.id);
      if (wu.status !== 'blocked') {
        throw new HttpError(409, 'NOT_BLOCKED', `WorkUnit 当前状态为 ${wu.status}，仅 blocked（裁决轮挂起）可提交裁决`);
      }
      const meta = parseWuMetadata(wu.metadata);
      if (!Array.isArray(meta.planRulings) || meta.planRulings.length === 0) {
        throw new HttpError(409, 'NO_PENDING_RULING', '该任务无待裁的裁决轮（planRulings 为空）');
      }
      const items = validateRulingItems(input.body.items);
      return applyPlanRuling(input.params.id, items, getStore());
    } catch (err) {
      if (err instanceof PlanRulingError) throw new HttpError(400, 'INVALID_RULING', (err as Error).message);
      throw err;
    }
  },
));

/**
 * POST /:id/direction — #567：方向锁定提交（human-only，结构化表单通道，仿 /:id/ruling）。
 * plan 会话存在互斥大方向时先出一次方向卡（NEED_INPUT + DIRECTION: 行 → metadata.planDirections）；
 * 人单选一个方向（可附补充说明）经本端点提交：applyPlanDirection 落探路台账
 * （decisions[] 追加「方向：…（人锁定）」结论）+ 组合选定文本复活同会话（pendingReplies 注入）。
 * 前置守卫：仅 blocked 且 metadata.planDirections 非空（方向锁定挂起中）；载荷非法 → 400。
 */
writeRoutes.post('/:id/direction', defineRoute(
  { params: wuIdParamsSchema, body: planDirectionPayloadSchema },
  async (_req, _res, input) => {
    // P2-c 拆环：动态 import + try/catch 等价原 errors 映射（PlanDirectionError → 400 INVALID_DIRECTION）
    const { applyPlanDirection, validateDirectionPick, PlanDirectionError } = await import('../pmo/index.js');
    try {
      const wu = await mustGetWu(input.params.id);
      if (wu.status !== 'blocked') {
        throw new HttpError(409, 'NOT_BLOCKED', `WorkUnit 当前状态为 ${wu.status}，仅 blocked（方向锁定挂起）可提交方向选定`);
      }
      const meta = parseWuMetadata(wu.metadata);
      if (!meta.planDirections || !Array.isArray(meta.planDirections.options) || meta.planDirections.options.length === 0) {
        throw new HttpError(409, 'NO_PENDING_DIRECTION', '该任务无待选的方向锁定（planDirections 为空）');
      }
      const pick = validateDirectionPick(input.body, meta.planDirections);
      return applyPlanDirection(input.params.id, pick, getStore());
    } catch (err) {
      if (err instanceof PlanDirectionError) throw new HttpError(400, 'INVALID_DIRECTION', (err as Error).message);
      throw err;
    }
  },
));

/**
 * POST /:id/close — #185（决策 #87 D2）：Web 按钮通道「关闭任务」（死信显式关闭路径，human-only）。
 * 复用 #57 D4 关闭路径：显式状态迁移 + 频道通知 + workunit:closed 结构化事件（不靠文本魔法串）。
 * decision/spec 裁剪状态机无 closed → 409 NO_CLOSED_STATE（拒绝说明已同步发到频道）。
 */
writeRoutes.post('/:id/close', defineRoute(
  { params: wuIdParamsSchema },
  async (_req, _res, input) => {
    const wu = await mustGetWu(input.params.id);
    if (wu.status !== 'blocked') {
      throw new HttpError(409, 'NOT_BLOCKED', `WorkUnit 当前状态为 ${wu.status}，仅 blocked 可关闭`);
    }
    const outcome = await closeBlockedWorkUnitFromWeb(input.params.id, getStore());
    if (outcome === 'rejected-no-closed-state') {
      throw new HttpError(409, 'NO_CLOSED_STATE', `该类型（${wu.type}，人工验收类）无 closed 状态，不支持关闭；如需继续请回复指导意见`);
    }
    if (outcome !== 'closed') {
      throw new HttpError(409, 'NOT_BLOCKED', 'WorkUnit 状态已变化，关闭未完成');
    }
    return service.getById(input.params.id);
  },
));

/**
 * POST /:id/status — transition WorkUnit status (state machine)
 * #237：同 review 系端点的 human-only 约定（A2A §4.4-2）——agent 身份调用一律 403。
 * agent 可经此端点直推 in_review→done 绕过评审链且不落 attestation 台账（只有
 * reviewPassed/reviewRejected 落账），故收口。agent 内部合法迁移走服务层
 * transitionStatus，不经 REST，不受影响。
 */
writeRoutes.post('/:id/status', requireHuman('Status transitions are human-only (authorType=agent rejected)'), defineRoute(
  { params: wuIdParamsSchema, body: transitionStatusBodySchema },
  {
    errors: [
      { match: 'Invalid status transition', status: 400, code: 'INVALID_TRANSITION' },
      { match: 'not found', status: 404, code: 'NOT_FOUND' },
    ],
  },
  async (req, _res, input) =>
    service.transitionStatus(input.params.id, input.body.status, { id: req.user?.id ?? 'unknown', type: 'human' }),
));

// ── 讨论空间 (AS-025 §5.16) ──

/** GET /:id/messages — list messages in discussion space (workUnitId grouping) */
openRoutes.get('/:id/messages', defineRoute(
  { params: wuIdParamsSchema, query: listMessagesQuerySchema },
  async (_req, _res, input) => {
    const take = Math.min(Number(input.query.limit ?? '50'), 100);
    const beforeDate = input.query.before ? new Date(input.query.before) : undefined;

    // #529：从 WU 解析频道归属（一等列 channelId，与写侧 POST /:id/messages 同字段、
    // 读写对称）传给直查；wu 不存在或无 channelId（legacy/手工单）→ undefined 走扇出 fallback。
    const wu = await service.getById(input.params.id);
    const { channelMessageService } = await import('../channels/index.js'); // P2-c 拆环
    const result = await channelMessageService.listByWorkUnitId(input.params.id, {
      channelId: wu?.channelId ?? undefined,
      before: beforeDate,
      limit: take,
    });

    return {
      messages: result.data,
      total: result.total,
      hasMore: result.data.length < result.total,
    };
  },
));

/** POST /:id/messages — send message in discussion space (auto-associate workUnitId) */
writeRoutes.post('/:id/messages', defineRoute(
  { params: wuIdParamsSchema, body: postMessageBodySchema },
  { status: 201 },
  async (_req, _res, input) => {
    const { content, replyToId, authorType = 'human', agentName } = input.body;

    // Verify WorkUnit exists
    const wu = await mustGetWu(input.params.id);

    // Need a channelId — use WorkUnit's channelId or fallback to system channel
    let channelId = wu.channelId;
    if (!channelId) {
      const rndChannels = await getStore().listChannels({ type: 'rnd' });
      const sysChannel = rndChannels.length > 0 ? rndChannels[0] : null;
      if (!sysChannel) {
        throw new HttpError(400, 'NO_CHANNEL', 'No channel available for discussion messages');
      }
      channelId = sysChannel.id;
    }

    const { channelMessageService } = await import('../channels/index.js'); // P2-c 拆环
    if (authorType === 'agent' && agentName) {
      return channelMessageService.createAgentMessage(
        channelId, agentName, content,
        { replyToId, workUnitId: input.params.id },
      );
    }
    return channelMessageService.createHumanMessage(
      channelId, content, replyToId, input.params.id,
    );
  },
));

/** PATCH /:id/messages/:messageId — edit message in discussion space */
writeRoutes.patch('/:id/messages/:messageId', defineRoute(
  { params: messageParamsSchema, body: patchMessageBodySchema },
  { errors: [{ match: 'not found', status: 404, code: 'NOT_FOUND' }] },
  async (_req, _res, input) => {
    const { content, meta } = input.body;

    if (content === undefined && meta === undefined) {
      throw new HttpError(400, 'INVALID_INPUT', 'content or meta is required');
    }

    // Verify message belongs to this WorkUnit
    // B2（#529 同款口径）：从 WU 解析频道归属直查，消全频道扇出；
    // wu 不存在或无 channelId（legacy/手工单）→ undefined 走扇出 fallback
    const wu = await service.getById(input.params.id);
    const found = await getStore().getMessageById(input.params.messageId, wu?.channelId ?? undefined);
    if (!found) {
      throw new HttpError(404, 'NOT_FOUND', `Message ${input.params.messageId} not found`);
    }
    if (found.message.workUnitId !== input.params.id) {
      throw new HttpError(400, 'INVALID_INPUT', 'Message does not belong to this WorkUnit');
    }

    const { channelMessageService } = await import('../channels/index.js'); // P2-c 拆环
    return channelMessageService.updateMessage(input.params.messageId, {
      content,
      meta: meta as MessageMeta | undefined,
    }, found.channelId);
  },
));

export { openRoutes as workunitOpenRoutes, writeRoutes as workunitWriteRoutes };
