/**
 * WorkUnit API 路由 (AS-025 §3.28c-1, §5.16)
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
 * #551：本层只做 HTTP 翻译——错误契约收口 http-helpers.ts（一张映射表 + sendMappedError
 * 唯一出口），human-only 守卫 = requireHuman 中间件，verify 业务下沉 WorkUnitService.verifyManually。
 */

import { Router, type Request } from 'express';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from './workunit.service.js';
import { parseWuMetadata } from './wu-metadata.js';
import { resolveClaimable, buildStatusById } from './wu-dependencies.js';
import { adoptInspectionOpportunity, ignoreInspectionOpportunity } from './inspection-opportunities.js';
import { resolveReviewConfirm } from './confirm-payload.js';
import { aggregateTreeTokens } from '../agents/token-usage.service.js';
import { channelMessageService } from '../channels/channel-message.service.js';
import { resumeBlockedWorkUnitFromWeb, closeBlockedWorkUnitFromWeb } from './waiting-input.js';
import { applyPlanRuling, validateRulingItems } from '../pmo/plan-ruling.js';
import { applyPlanDirection, validateDirectionPick } from '../pmo/plan-direction.js';
import { claimWorkUnitAndAnnounce } from './claim-announce.js';
import { listWorkUnitChangedFiles } from './wu-changed-files.js';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';
import { requireAuth, requireNotGuest, type AuthRequest } from '../../middleware/auth.js';
import { HttpRouteError, WORKUNIT_ERROR_MAPS, route, requireHuman } from './http-helpers.js';

const router = Router();
const fileStore = new FileStore();
const service = new WorkUnitService(fileStore);
// #387: 单次批量 id 上限（调用方单页规模 ≤ 数十，留余量；超出静默截断）
const MAX_BATCH_IDS = 100;

/** human-only 端点的 403 文案（A2A §4.4-2，沿用原内联守卫措辞） */
const REVIEW_HUMAN_ONLY = 'Review actions are human-only (authorType=agent rejected)';

/** getById 或抛 404——各端点「WU 必须存在」前置守卫的统一写法 */
async function mustGetWu(id: string): Promise<WorkUnitData> {
  const wu = await service.getById(id);
  if (!wu) throw new HttpRouteError(404, 'NOT_FOUND', `WorkUnit ${id} not found`);
  return wu;
}

/** requireAuth 后取署名（本地模式回落 Local User/id），review/verify 落台账 by 字段共用 */
function callerName(req: Request): string {
  const user = (req as AuthRequest).user;
  return user?.name ?? user?.email ?? user?.id ?? 'human';
}

/** GET / — list WorkUnits */
router.get('/', route([], async (req, res) => {
  const { type, status, assigneeId, channelId, parentId, attributed, projectId, q } = req.query;
  const { page, limit } = parsePagination(req);

  const result = await service.list({
    type: type as string,
    status: status as string,
    assigneeId: assigneeId as string,
    channelId: channelId as string,
    parentId: parentId as string,
    // #428：attributed=true/false 显式布尔；其他值（含缺省）= undefined 不过滤
    attributed: attributed === 'true' ? true : attributed === 'false' ? false : undefined,
    // #456：PMO 项目归属过滤（空串不过滤）
    projectId: typeof projectId === 'string' && projectId ? projectId : undefined,
    // 批次 D-2 项4：标题搜索（scope 子串，大小写不敏感）；空白 q 不过滤
    q: typeof q === 'string' && q.trim() ? q.trim() : undefined,
    page,
    limit,
  });

  // #109：列表项附「可认领」标记（claimable）供 UI 使用 —— unassigned 且
  // blockedBy 依赖全了结才为 true；profile 无关（认领侧仍由 loop observe 判定）。
  // 仅当本页含 unassigned 行才读 index 做依赖判定（其余行 claimable 恒 false）
  const statusById = result.data.some(w => w.status === 'unassigned')
    ? buildStatusById(await fileStore.getIndex())
    : new Map<string, string>();
  const data = result.data.map(w => ({ ...w, claimable: resolveClaimable(w, statusById) }));

  res.json(formatPaginatedResponse(data, result.total, page, limit));
}));

/** POST / — create WorkUnit */
router.post('/', requireAuth(), requireNotGuest(), route([], async (req, res) => {
  const { scope, type, assigneeId, status, channelId, parentId, metadata, projectPath } = req.body;

  if (!scope || typeof scope !== 'string') {
    throw new HttpRouteError(400, 'INVALID_INPUT', 'scope is required and must be a string');
  }

  const wu = await service.create({ scope, type, assigneeId, status, channelId, parentId, metadata, projectPath });
  res.status(201).json(wu);
}));

/** POST /from-message — convert ChannelMessage to WorkUnit (emergence path) */
router.post('/from-message', requireAuth(), requireNotGuest(), route(WORKUNIT_ERROR_MAPS.fromMessage, async (req, res) => {
  const { messageId, type, metadata, channelId } = req.body;

  if (!messageId || typeof messageId !== 'string') {
    throw new HttpRouteError(400, 'INVALID_INPUT', 'messageId is required');
  }

  // #524 P1-1：body.channelId 可选透传 → 按频道直查，免全频道扫描反查
  const wu = await service.createFromMessage(messageId, {
    type, metadata,
    channelId: typeof channelId === 'string' && channelId ? channelId : undefined,
  });
  res.status(201).json(wu);
}));

/**
 * GET /last-done?assigneeIds=a,b,c — #387 批量聚合：每 assignee 最近一条完成 WU
 * （done/completed，completedAt ?? updatedAt 降序取首条；无完成记录 → null）。
 * roster 空闲卡「最近完成」专用，消逐实例 GET /workunits?assigneeId= 的 N+1。
 */
router.get('/last-done', route([], async (req, res) => {
  const raw = req.query.assigneeIds;
  const ids = typeof raw === 'string'
    ? raw.split(',').map(s => s.trim()).filter(s => s.length > 0)
    : [];
  if (ids.length === 0) {
    throw new HttpRouteError(400, 'INVALID_INPUT', 'assigneeIds is required (comma-separated ids)');
  }
  const data = await service.lastDoneByAssignee(ids.slice(0, MAX_BATCH_IDS));
  res.json({ success: true, data });
}));

/** GET /:id — get WorkUnit by id */
router.get('/:id', route([], async (req, res) => {
  res.json(await mustGetWu(req.params.id));
}));

/** PUT /:id — update WorkUnit */
router.put('/:id', requireAuth(), requireNotGuest(), route(WORKUNIT_ERROR_MAPS.update, async (req, res) => {
  res.json(await service.update(req.params.id, req.body));
}));

/**
 * #163（T8-E2，#130 决策 6）：巡检机会采纳——建 feature 子单（显式 unassigned 进
 * frontier，采纳动作即人工闸），源条目记 wuId。机制在 inspection-opportunities.ts。
 */
router.post('/:id/opportunities/:oppId/adopt', requireAuth(), requireNotGuest(), route(WORKUNIT_ERROR_MAPS.opportunity, async (req, res) => {
  const result = await adoptInspectionOpportunity(service, req.params.id, req.params.oppId);
  res.status(201).json(result);
}));

/** #163（T8-E2）：巡检机会忽略——终态，可附理由（body.reason，下轮巡检不重复上报的判据） */
router.post('/:id/opportunities/:oppId/ignore', requireAuth(), requireNotGuest(), route(WORKUNIT_ERROR_MAPS.opportunity, async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  const result = await ignoreInspectionOpportunity(service, req.params.id, req.params.oppId, reason);
  res.json(result);
}));

/** GET /:id/tree-tokens - 树级 token 开销聚合（AC-5.4, §8.4.4） */
router.get('/:id/tree-tokens', route([], async (req, res) => {
  const wu = await mustGetWu(req.params.id);
  const meta = parseWuMetadata(wu.metadata);
  const rootId = meta.collab?.rootId ?? wu.id;
  const report = await aggregateTreeTokens(rootId, fileStore);
  res.json(report);
}));

/**
 * GET /:id/changed-files — #285 AC4（决策 #249 §5）：per-WU 产出/修改文件集
 * （session:start.workUnitId → file:change 绝对路径；无数据/读取失败 → 空数组，
 * 前端文件 chip 降级候选集词表）。只读，匿名公开（与 GET /:id 同口径）。
 */
router.get('/:id/changed-files', route([], async (req, res) => {
  const files = await listWorkUnitChangedFiles(req.params.id);
  res.json({ success: true, data: { files } });
}));

/** DELETE /:id — delete WorkUnit */
router.delete('/:id', requireAuth(), requireNotGuest(), route(WORKUNIT_ERROR_MAPS.deleteWu, async (req, res) => {
  await service.delete(req.params.id);
  res.status(204).send();
}));

/** POST /:id/claim — claim WorkUnit（flock 悲观互斥锁）；#445：认领即发声原语接入（与 loop 自动认领同路径） */
router.post('/:id/claim', requireAuth(), requireNotGuest(), route(WORKUNIT_ERROR_MAPS.claim, async (req, res) => {
  // #445：agentId 可省略——缺省 = 当前登录用户（人工引导片认领，身份诚实归因会话用户）；
  // 显式传入保持旧契约（认领给指定 id）。requireAuth 保证 req.user 存在（none 模式注入 local）。
  const bodyAgentId = typeof req.body?.agentId === 'string' && req.body.agentId ? req.body.agentId : undefined;
  const claimerId = bodyAgentId ?? req.user?.id;
  if (!claimerId) {
    throw new HttpRouteError(400, 'INVALID_INPUT', 'agentId is required');
  }
  // 发声署名：人工认领署用户显示名；显式 agentId 旧契约无法廉价解析角色名 → 退化为 id
  const claimerName = bodyAgentId ?? req.user?.name ?? req.user?.email ?? claimerId;

  const wu = await claimWorkUnitAndAnnounce(req.params.id, claimerId, claimerName, { wuService: service, fileStore });
  res.json(wu);
}));

/** POST /:id/unclaim — unclaim WorkUnit */
router.post('/:id/unclaim', requireAuth(), requireNotGuest(), route(WORKUNIT_ERROR_MAPS.unclaim, async (req, res) => {
  res.json(await service.unclaim(req.params.id));
}));

/** POST /:id/review-passed — review approved (in_review → done) */
router.post('/:id/review-passed', requireAuth(), requireNotGuest(), requireHuman(REVIEW_HUMAN_ONLY), route(WORKUNIT_ERROR_MAPS.reviewPassed, async (req, res) => {
  // F6（决策 1）：人工确认落台账 l3 —— by 取登录用户名（本地模式回落 Local User/id）
  // #110：可选 body.summary（人点通过时填写的结论文本）穿透进 l3 台账——
  // pmo/decision-resolution 订阅器据此把 decision 单结论原样写入探路地图 decisions[]
  // #463：可选 body.confirm 结构化评审表单（decision/spec/analysis）——后端序列化为
  // l3.summary（存储契约不变，人不接触魔法行）；与裸 summary 并存时 confirm 优先；
  // analysis 的 tasks 经 options.analysisTasks 透传覆写 metadata.analysisTasks。
  const confirm = resolveReviewConfirm(req.body?.confirm);
  const rawSummary = req.body?.summary;
  const summary = confirm.summary
    ?? (typeof rawSummary === 'string' && rawSummary.trim() ? rawSummary : undefined);
  // #177：可选 defaultAssigneeId（profile id）——analysis 确认处「默认执行角色」，
  // 落 WU metadata.defaultTaskAssigneeId，analysis-handoff 应用于全部派生 task 子 WU
  const defaultAssigneeId = req.body?.defaultAssigneeId;
  const options = {
    ...(typeof defaultAssigneeId === 'string' && defaultAssigneeId.trim()
      ? { defaultTaskAssigneeId: defaultAssigneeId.trim() } : {}),
    ...(confirm.analysisTasks !== undefined ? { analysisTasks: confirm.analysisTasks } : {}),
  };
  const wu = await service.reviewPassed(req.params.id, {
    by: callerName(req),
    kind: 'human-confirm',
    ...(summary ? { summary } : {}),
  }, Object.keys(options).length > 0 ? options : undefined);
  res.json(wu);
}));

/** POST /:id/review-rejected — review rejected (in_review → active, or blocked after 3) */
router.post('/:id/review-rejected', requireAuth(), requireNotGuest(), requireHuman(REVIEW_HUMAN_ONLY), route(WORKUNIT_ERROR_MAPS.reviewRejected, async (req, res) => {
  // F6（决策 1）：人工否决同样落台账 l3（rejected 留痕）
  const wu = await service.reviewRejected(req.params.id, req.body?.reason, {
    by: callerName(req),
    kind: 'human-confirm',
  });
  res.json(wu);
}));

/**
 * POST /:id/verify — F6-c（断点 2）：人工重跑 L1 自动验证（human-only，验收权只在人同 A2A §4.4）。
 * 仅代码类 WU（task/bug/feature/refactor）且有 worktree 落档；body.commands 可选
 * （传了视为 metadata.verifyCommands 覆盖）。只补写台账 l1/verifyReport，不动 WU status；
 * 写完发 status_changed（状态值不变也发）让 pmo rollup 按证据齐备度重估。
 * #551：业务下沉 WorkUnitService.verifyManually（脱 HTTP 可直测），本层只映射 kind → 响应。
 */
router.post('/:id/verify', requireAuth(), requireNotGuest(), requireHuman('Verify actions are human-only (authorType=agent rejected)'), route([], async (req, res) => {
  const bodyCommands = Array.isArray(req.body?.commands)
    ? (req.body.commands as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  const result = await service.verifyManually(req.params.id, {
    by: callerName(req),
    ...(bodyCommands.length > 0 ? { commands: bodyCommands } : {}),
  });
  switch (result.kind) {
    case 'not-found':
      throw new HttpRouteError(404, 'NOT_FOUND', `WorkUnit ${req.params.id} not found`);
    case 'not-code-type':
      throw new HttpRouteError(400, 'INVALID_INPUT', `仅代码类 WU（task/bug/feature/refactor）支持 L1 验证（当前 type=${result.wuType}）`);
    case 'no-worktree':
      throw new HttpRouteError(409, 'NO_WORKTREE', 'WU 无 worktree 落档（metadata.worktreePath 为空），无法验证');
    case 'no-commands':
      res.status(422).json({
        verified: false,
        reason: 'no-commands',
        hint: '请在 WU metadata.verifyCommands 或 worktree 的 package.json scripts(test/typecheck/lint)中配置验证命令',
      });
      return;
    case 'failed':
      res.json({ verified: false, failed: [result.failure] });
      return;
    case 'verified':
      res.json({ verified: true, report: result.report });
  }
}));

/**
 * POST /:id/dispatch-review — F6-c（断点 3）：人工补派 agent 评审（human-only）。
 * 父 WU 被人工直推 done（或 in_review 但评审子 WU 缺失）时补建 review 子 WU，
 * 走与 ReviewDispatcher 路径 A 相同的未指派涌现 + excludeAssignee/自评兜底逻辑。
 */
router.post('/:id/dispatch-review', requireAuth(), requireNotGuest(), requireHuman(REVIEW_HUMAN_ONLY), route(WORKUNIT_ERROR_MAPS.dispatchReview, async (req, res) => {
  // 与 index.ts 启动时同款动态 import：避免路由模块加载时拉起整个 agents 模块图
  const { getReviewDispatcher } = await import('../agents/loop/review-dispatcher.js') as typeof import('../agents/loop/review-dispatcher.js');
  const child = await getReviewDispatcher().dispatchReviewNow(req.params.id);
  res.json({ reviewWorkUnitId: child.id });
}));

/**
 * POST /:id/resume — #185（决策 #87 D2）：Web 按钮通道「继续执行」（纯授权复活，human-only）。
 * 与频道回复路径共享同一复活原语（重置 consecutiveStuck/blockReason、记 resumeCount、
 * timeoutReleaseCount 终身保留），pendingReplies 注入固定占位文案；复活后发 Studio 系统消息里程碑。
 * 分类型显示是 UI 层决策（D3），端点不设类型门槛；归属等待型按回复语义不被纯授权复活 → 409。
 */
router.post('/:id/resume', requireAuth(), requireNotGuest(), route([], async (req, res) => {
  const wu = await mustGetWu(req.params.id);
  if (wu.status !== 'blocked') {
    throw new HttpRouteError(409, 'NOT_BLOCKED', `WorkUnit 当前状态为 ${wu.status}，仅 blocked 可继续执行`);
  }
  const resumed = await resumeBlockedWorkUnitFromWeb(req.params.id, fileStore);
  if (!resumed) {
    throw new HttpRouteError(409, 'RESUME_REJECTED', '复活未完成（等待工程归属的任务请在频道回复工程名或路径）');
  }
  res.json(await service.getById(req.params.id));
}));

/**
 * POST /:id/ruling — #467：裁决轮一次性提交（human-only，结构化表单通道）。
 * plan 会话 fog 调研齐后出一次裁决卡（NEED_INPUT + RULING 行 → metadata.planRulings）；
 * 人一次操作（全对 / 单题修改 / 某题打回重议）经本端点提交：applyPlanRuling 批量落探路台账
 * （decisions[] + fog resolved/open）+ 组合裁决结果文本复活同会话（pendingReplies 注入）。
 * 前置守卫：仅 blocked 且 metadata.planRulings 非空（裁决轮挂起中）；载荷非法 → 400。
 */
router.post('/:id/ruling', requireAuth(), requireNotGuest(), route(WORKUNIT_ERROR_MAPS.ruling, async (req, res) => {
  const wu = await mustGetWu(req.params.id);
  if (wu.status !== 'blocked') {
    throw new HttpRouteError(409, 'NOT_BLOCKED', `WorkUnit 当前状态为 ${wu.status}，仅 blocked（裁决轮挂起）可提交裁决`);
  }
  const meta = parseWuMetadata(wu.metadata);
  if (!Array.isArray(meta.planRulings) || meta.planRulings.length === 0) {
    throw new HttpRouteError(409, 'NO_PENDING_RULING', '该任务无待裁的裁决轮（planRulings 为空）');
  }
  const items = validateRulingItems(req.body?.items);
  const updated = await applyPlanRuling(req.params.id, items, fileStore);
  res.json(updated);
}));

/**
 * POST /:id/direction — #567：方向锁定提交（human-only，结构化表单通道，仿 /:id/ruling）。
 * plan 会话存在互斥大方向时先出一次方向卡（NEED_INPUT + DIRECTION 行 → metadata.planDirections）；
 * 人单选一个方向（可附补充说明）经本端点提交：applyPlanDirection 落探路台账
 * （decisions[] 追加「方向：…（人锁定）」结论）+ 组合选定文本复活同会话（pendingReplies 注入）。
 * 前置守卫：仅 blocked 且 metadata.planDirections 非空（方向锁定挂起中）；载荷非法 → 400。
 */
router.post('/:id/direction', requireAuth(), requireNotGuest(), route(WORKUNIT_ERROR_MAPS.direction, async (req, res) => {
  const wu = await mustGetWu(req.params.id);
  if (wu.status !== 'blocked') {
    throw new HttpRouteError(409, 'NOT_BLOCKED', `WorkUnit 当前状态为 ${wu.status}，仅 blocked（方向锁定挂起）可提交方向选定`);
  }
  const meta = parseWuMetadata(wu.metadata);
  if (!meta.planDirections || !Array.isArray(meta.planDirections.options) || meta.planDirections.options.length === 0) {
    throw new HttpRouteError(409, 'NO_PENDING_DIRECTION', '该任务无待选的方向锁定（planDirections 为空）');
  }
  const pick = validateDirectionPick(req.body, meta.planDirections);
  const updated = await applyPlanDirection(req.params.id, pick, fileStore);
  res.json(updated);
}));

/**
 * POST /:id/close — #185（决策 #87 D2）：Web 按钮通道「关闭任务」（死信显式关闭路径，human-only）。
 * 复用 #57 D4 关闭路径：显式状态迁移 + 频道通知 + workunit:closed 结构化事件（不靠文本魔法串）。
 * decision/spec 裁剪状态机无 closed → 409 NO_CLOSED_STATE（拒绝说明已同步发到频道）。
 */
router.post('/:id/close', requireAuth(), requireNotGuest(), route([], async (req, res) => {
  const wu = await mustGetWu(req.params.id);
  if (wu.status !== 'blocked') {
    throw new HttpRouteError(409, 'NOT_BLOCKED', `WorkUnit 当前状态为 ${wu.status}，仅 blocked 可关闭`);
  }
  const outcome = await closeBlockedWorkUnitFromWeb(req.params.id, fileStore);
  if (outcome === 'rejected-no-closed-state') {
    throw new HttpRouteError(409, 'NO_CLOSED_STATE', `该类型（${wu.type}，人工验收类）无 closed 状态，不支持关闭；如需继续请回复指导意见`);
  }
  if (outcome !== 'closed') {
    throw new HttpRouteError(409, 'NOT_BLOCKED', 'WorkUnit 状态已变化，关闭未完成');
  }
  res.json(await service.getById(req.params.id));
}));

/**
 * POST /:id/status — transition WorkUnit status (state machine)
 * #237：同 review 系端点的 human-only 约定（A2A §4.4-2）——agent 身份调用一律 403。
 * agent 可经此端点直推 in_review→done 绕过评审链且不落 attestation 台账（只有
 * reviewPassed/reviewRejected 落账），故收口。agent 内部合法迁移走服务层
 * transitionStatus，不经 REST，不受影响。
 */
router.post('/:id/status', requireAuth(), requireNotGuest(), requireHuman('Status transitions are human-only (authorType=agent rejected)'), route(WORKUNIT_ERROR_MAPS.status, async (req, res) => {
  const { status } = req.body;
  if (!status || typeof status !== 'string') {
    throw new HttpRouteError(400, 'INVALID_INPUT', 'status is required');
  }
  res.json(await service.transitionStatus(req.params.id, status));
}));

// ── 讨论空间 (AS-025 §5.16) ──

/** GET /:id/messages — list messages in discussion space (workUnitId grouping) */
router.get('/:id/messages', route([], async (req, res) => {
  const { before, limit = '50' } = req.query;
  const take = Math.min(Number(limit), 100);
  const beforeDate = before ? new Date(before as string) : undefined;

  // #529：从 WU 解析频道归属（一等列 channelId，与写侧 POST /:id/messages 同字段、
  // 读写对称）传给直查；wu 不存在或无 channelId（legacy/手工单）→ undefined 走扇出 fallback。
  const wu = await service.getById(req.params.id);
  const result = await channelMessageService.listByWorkUnitId(req.params.id, {
    channelId: wu?.channelId ?? undefined,
    before: beforeDate,
    limit: take,
  });

  res.json({
    success: true,
    data: result.data,
    total: result.total,
    hasMore: result.data.length < result.total,
  });
}));

/** POST /:id/messages — send message in discussion space (auto-associate workUnitId) */
router.post('/:id/messages', requireAuth(), requireNotGuest(), route([], async (req, res) => {
  const { content, replyToId, authorType = 'human', agentName } = req.body;

  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new HttpRouteError(400, 'INVALID_INPUT', 'content is required');
  }

  // Verify WorkUnit exists
  const wu = await mustGetWu(req.params.id);

  // Need a channelId — use WorkUnit's channelId or fallback to system channel
  let channelId = wu.channelId;
  if (!channelId) {
    const rndChannels = await fileStore.listChannels({ type: 'rnd' });
    const sysChannel = rndChannels.length > 0 ? rndChannels[0] : null;
    if (!sysChannel) {
      throw new HttpRouteError(400, 'NO_CHANNEL', 'No channel available for discussion messages');
    }
    channelId = sysChannel.id;
  }

  let message;
  if (authorType === 'agent' && agentName) {
    message = await channelMessageService.createAgentMessage(
      channelId, agentName, content.trim(),
      { replyToId, workUnitId: req.params.id },
    );
  } else {
    message = await channelMessageService.createHumanMessage(
      channelId, content.trim(), replyToId, req.params.id,
    );
  }

  res.status(201).json(message);
}));

/** PATCH /:id/messages/:messageId — edit message in discussion space */
router.patch('/:id/messages/:messageId', requireAuth(), requireNotGuest(), route(WORKUNIT_ERROR_MAPS.editMessage, async (req, res) => {
  const { content, meta } = req.body;

  if (content === undefined && meta === undefined) {
    throw new HttpRouteError(400, 'INVALID_INPUT', 'content or meta is required');
  }

  // Verify message belongs to this WorkUnit
  const found = await fileStore.getMessageById(req.params.messageId);
  if (!found) {
    throw new HttpRouteError(404, 'NOT_FOUND', `Message ${req.params.messageId} not found`);
  }
  if (found.message.workUnitId !== req.params.id) {
    throw new HttpRouteError(400, 'INVALID_INPUT', 'Message does not belong to this WorkUnit');
  }

  const updated = await channelMessageService.updateMessage(req.params.messageId, {
    content,
    meta,
  }, found.channelId);

  res.json(updated);
}));

export default router;
