/**
 * WorkUnit API 路由 (AS-025 §3.28c-1, §5.16)
 *
 * Endpoints:
 *   GET    /api/v1/workunits          — list（#109：列表项附 claimable 可认领标记）
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
 *   POST   /api/v1/workunits/:id/resume — #185（决策 #87 D2）：Web 按钮通道「继续执行」（与回复路径共享复活原语）
 *   POST   /api/v1/workunits/:id/close  — #185（决策 #87 D2）：Web 按钮通道「关闭任务」（死信显式关闭路径）
 *
 * 涌现路径 (AS-025 §5.15):
 *   POST   /api/v1/workunits/from-message — convert ChannelMessage to WorkUnit
 *
 * 讨论空间 (AS-025 §5.16):
 *   GET    /api/v1/workunits/:id/messages       — list messages by workUnitId
 *   POST   /api/v1/workunits/:id/messages       — send message (auto-associate workUnitId)
 *   PATCH  /api/v1/workunits/:id/messages/:messageId — edit message
 */

import { Router, type Request, type Response } from 'express';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from './workunit.service.js';
import { parseWuMetadata } from './wu-metadata.js';
import { resolveClaimable, buildStatusById } from './wu-dependencies.js';
import { aggregateTreeTokens } from '../agents/token-usage.service.js';
import { CODE_WORKTREE_TYPES, resolveVerifyCommands, runWuVerification } from '../agents/loop/wu-verification.js';
import { channelMessageService } from '../channels/channel-message.service.js';
import { resumeBlockedWorkUnitFromWeb, closeBlockedWorkUnitFromWeb } from './waiting-input.js';
import { getErrorMessage } from '../../utils/errors.js';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';
import { requireAuth, requireNotGuest, type AuthRequest } from '../../middleware/auth.js';

const router = Router();
const fileStore = new FileStore();
const service = new WorkUnitService(fileStore);

/**
 * A2A §4.4: 调用方 authorType 识别（body.authorType 优先，其次 x-author-type header）。
 * 与讨论空间发帖的 authorType 字段同约定；UI/人类调用不发送该字段 → 'human'。
 */
function resolveCallerAuthorType(req: Request): string {
  const fromBody = typeof req.body?.authorType === 'string' ? req.body.authorType : undefined;
  const fromHeader = req.headers['x-author-type'];
  return fromBody ?? (typeof fromHeader === 'string' ? fromHeader : 'human');
}

/** GET / — list WorkUnits */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { type, status, assigneeId, channelId, parentId } = req.query;
    const { page, limit } = parsePagination(req);

    const result = await service.list({
      type: type as string,
      status: status as string,
      assigneeId: assigneeId as string,
      channelId: channelId as string,
      parentId: parentId as string,
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
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** POST / — create WorkUnit */
router.post('/', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { scope, type, assigneeId, status, channelId, parentId, metadata, projectPath } = req.body;

    if (!scope || typeof scope !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'scope is required and must be a string' },
      });
    }

    const wu = await service.create({
      scope,
      type,
      assigneeId,
      status,
      channelId,
      parentId,
      metadata,
      projectPath,
    });

    res.status(201).json(wu);
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** POST /from-message — convert ChannelMessage to WorkUnit (emergence path) */
router.post('/from-message', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { messageId, type, metadata } = req.body;

    if (!messageId || typeof messageId !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'messageId is required' },
      });
    }

    const wu = await service.createFromMessage(messageId, { type, metadata });
    res.status(201).json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
    }
    if (msg.includes('already linked')) {
      return res.status(409).json({ error: { code: 'ALREADY_CONVERTED', message: msg } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/** GET /:id — get WorkUnit by id */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const wu = await service.getById(req.params.id);

    if (!wu) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `WorkUnit ${req.params.id} not found` },
      });
    }

    res.json(wu);
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** PUT /:id — update WorkUnit */
router.put('/:id', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const wu = await service.update(req.params.id, req.body);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found') || msg.includes('Record to update not found')) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

/** GET /:id/tree-tokens - 树级 token 开销聚合（AC-5.4, §8.4.4） */
router.get('/:id/tree-tokens', async (req: Request, res: Response) => {
  try {
    const wu = await service.getById(req.params.id);
    if (!wu) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `WorkUnit ${req.params.id} not found` },
      });
    }
    const meta = parseWuMetadata(wu.metadata);
    const rootId = meta.collab?.rootId ?? wu.id;
    const report = await aggregateTreeTokens(rootId, fileStore);
    res.json(report);
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** DELETE /:id — delete WorkUnit */
router.delete('/:id', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    await service.delete(req.params.id);
    res.status(204).send();
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found') || msg.includes('Record to delete does not exist')) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

/** POST /:id/claim — claim WorkUnit（flock 悲观互斥锁） */
router.post('/:id/claim', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { agentId } = req.body;
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'agentId is required' },
      });
    }

    const wu = await service.claim(req.params.id, agentId);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg === 'Claim failed') {
      return res.status(409).json({
        error: { code: 'CLAIM_FAILED', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

/** POST /:id/unclaim — unclaim WorkUnit */
router.post('/:id/unclaim', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const wu = await service.unclaim(req.params.id);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found') || msg.includes('Record to update not found')) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

/** POST /:id/review-passed — review approved (in_review → done) */
router.post('/:id/review-passed', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    // A2A §4.4-2 / §8-Q3: 验收权只在人 —— agent 身份调用一律 403。
    // 身份约定：调用方在 body.authorType 或 x-author-type header 声明；
    // UI/人类调用不发送该字段（或发送 'human'）。
    if (resolveCallerAuthorType(req) === 'agent') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Review actions are human-only (authorType=agent rejected)' },
      });
    }
    // F6（决策 1）：人工确认落台账 l3 —— by 取登录用户名（本地模式回落 Local User/id）
    // #110：可选 body.summary（人点通过时填写的结论文本）穿透进 l3 台账——
    // pmo/decision-resolution 订阅器据此把 decision 单结论原样写入探路地图 decisions[]
    const user = (req as AuthRequest).user;
    const summary = req.body?.summary;
    // #177：可选 defaultAssigneeId（profile id）——analysis 确认处「默认执行角色」，
    // 落 WU metadata.defaultTaskAssigneeId，analysis-handoff 应用于全部派生 task 子 WU
    const defaultAssigneeId = req.body?.defaultAssigneeId;
    const wu = await service.reviewPassed(req.params.id, {
      by: user?.name ?? user?.email ?? user?.id ?? 'human',
      kind: 'human-confirm',
      ...(typeof summary === 'string' && summary.trim() ? { summary } : {}),
    }, typeof defaultAssigneeId === 'string' && defaultAssigneeId.trim()
      ? { defaultTaskAssigneeId: defaultAssigneeId.trim() }
      : undefined);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
    }
    if (msg.includes('Cannot review')) {
      return res.status(400).json({ error: { code: 'INVALID_TRANSITION', message: msg } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/** POST /:id/review-rejected — review rejected (in_review → active, or blocked after 3) */
router.post('/:id/review-rejected', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    // A2A §4.4-2 / §8-Q3: 同 review-passed，agent 身份调用一律 403
    if (resolveCallerAuthorType(req) === 'agent') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Review actions are human-only (authorType=agent rejected)' },
      });
    }
    // F6（决策 1）：人工否决同样落台账 l3（rejected 留痕）
    const user = (req as AuthRequest).user;
    const wu = await service.reviewRejected(req.params.id, req.body?.reason, {
      by: user?.name ?? user?.email ?? user?.id ?? 'human',
      kind: 'human-confirm',
    });
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
    }
    if (msg.includes('Cannot review')) {
      return res.status(400).json({ error: { code: 'INVALID_TRANSITION', message: msg } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/**
 * POST /:id/verify — F6-c（断点 2）：人工重跑 L1 自动验证（human-only，验收权只在人同 A2A §4.4）。
 * 仅代码类 WU（task/bug/feature/refactor）且有 worktree 落档；body.commands 可选
 * （传了视为 metadata.verifyCommands 覆盖）。只补写台账 l1/verifyReport，不动 WU status；
 * 写完发 status_changed（状态值不变也发）让 pmo rollup 按证据齐备度重估。
 */
router.post('/:id/verify', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    if (resolveCallerAuthorType(req) === 'agent') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Verify actions are human-only (authorType=agent rejected)' },
      });
    }
    const wu = await service.getById(req.params.id);
    if (!wu) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `WorkUnit ${req.params.id} not found` },
      });
    }
    if (!CODE_WORKTREE_TYPES.has(wu.type)) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: `仅代码类 WU（task/bug/feature/refactor）支持 L1 验证（当前 type=${wu.type}）` },
      });
    }
    const metadata: WorkUnitMetadata = parseWuMetadata(wu.metadata);
    const worktreePath = typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0
      ? metadata.worktreePath
      : null;
    if (!worktreePath) {
      return res.status(409).json({
        error: { code: 'NO_WORKTREE', message: 'WU 无 worktree 落档（metadata.worktreePath 为空），无法验证' },
      });
    }
    // body.commands 视为 metadata.verifyCommands 覆盖（同 resolveVerifyCommands 的覆盖语义）
    const bodyCommands = Array.isArray(req.body?.commands)
      ? (req.body.commands as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      : [];
    const effectiveMeta: WorkUnitMetadata = bodyCommands.length > 0
      ? { ...metadata, verifyCommands: bodyCommands }
      : metadata;

    const { commands } = await resolveVerifyCommands(wu, effectiveMeta, worktreePath);
    if (commands.length === 0) {
      return res.status(422).json({
        verified: false,
        reason: 'no-commands',
        hint: '请在 WU metadata.verifyCommands 或 worktree 的 package.json scripts(test/typecheck/lint)中配置验证命令',
      });
    }

    const outcome = await runWuVerification(wu, effectiveMeta, worktreePath);
    // F6（决策 1）：人工重跑同样落台账 l1——by 取登录用户名（本地模式回落 Local User/id）
    const user = (req as AuthRequest).user;
    const updated = await service.recordL1Verification(wu.id, {
      by: user?.name ?? user?.email ?? user?.id ?? 'human',
      ran: outcome.ran,
      source: outcome.source,
      failure: outcome.failure,
    });

    if (outcome.failure) {
      return res.json({ verified: false, failed: [outcome.failure] });
    }
    const report = parseWuMetadata(updated.metadata).verifyReport
      ?? { commands: outcome.ran, source: outcome.source };
    res.json({ verified: true, report });
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) } });
  }
});

/**
 * POST /:id/dispatch-review — F6-c（断点 3）：人工补派 agent 评审（human-only）。
 * 父 WU 被人工直推 done（或 in_review 但评审子 WU 缺失）时补建 review 子 WU，
 * 走与 ReviewDispatcher 路径 A 相同的未指派涌现 + excludeAssignee/自评兜底逻辑。
 */
router.post('/:id/dispatch-review', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    if (resolveCallerAuthorType(req) === 'agent') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Review actions are human-only (authorType=agent rejected)' },
      });
    }
    // 与 index.ts 启动时同款动态 import：避免路由模块加载时拉起整个 agents 模块图
    const { getReviewDispatcher } = await import('../agents/loop/review-dispatcher.js') as typeof import('../agents/loop/review-dispatcher.js');
    const child = await getReviewDispatcher().dispatchReviewNow(req.params.id);
    res.json({ reviewWorkUnitId: child.id });
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
    }
    if (msg.includes('already')) {
      return res.status(409).json({ error: { code: 'ALREADY_SATISFIED', message: msg } });
    }
    if (msg.includes('Cannot dispatch') || msg.includes('not reviewable') || msg.includes('no channel')) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: msg } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
  }
});

/**
 * POST /:id/resume — #185（决策 #87 D2）：Web 按钮通道「继续执行」（纯授权复活，human-only）。
 * 与频道回复路径共享同一复活原语（重置 consecutiveStuck/blockReason、记 resumeCount、
 * timeoutReleaseCount 终身保留），pendingReplies 注入固定占位文案；复活后发 Studio 系统消息里程碑。
 * 分类型显示是 UI 层决策（D3），端点不设类型门槛；归属等待型按回复语义不被纯授权复活 → 409。
 */
router.post('/:id/resume', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const wu = await service.getById(req.params.id);
    if (!wu) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `WorkUnit ${req.params.id} not found` },
      });
    }
    if (wu.status !== 'blocked') {
      return res.status(409).json({
        error: { code: 'NOT_BLOCKED', message: `WorkUnit 当前状态为 ${wu.status}，仅 blocked 可继续执行` },
      });
    }
    const resumed = await resumeBlockedWorkUnitFromWeb(req.params.id, fileStore);
    if (!resumed) {
      return res.status(409).json({
        error: { code: 'RESUME_REJECTED', message: '复活未完成（等待工程归属的任务请在频道回复工程名或路径）' },
      });
    }
    const updated = await service.getById(req.params.id);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) } });
  }
});

/**
 * POST /:id/close — #185（决策 #87 D2）：Web 按钮通道「关闭任务」（死信显式关闭路径，human-only）。
 * 复用 #57 D4 关闭路径：显式状态迁移 + 频道通知 + workunit:closed 结构化事件（不靠文本魔法串）。
 * decision/spec 裁剪状态机无 closed → 409 NO_CLOSED_STATE（拒绝说明已同步发到频道）。
 */
router.post('/:id/close', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const wu = await service.getById(req.params.id);
    if (!wu) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `WorkUnit ${req.params.id} not found` },
      });
    }
    if (wu.status !== 'blocked') {
      return res.status(409).json({
        error: { code: 'NOT_BLOCKED', message: `WorkUnit 当前状态为 ${wu.status}，仅 blocked 可关闭` },
      });
    }
    const outcome = await closeBlockedWorkUnitFromWeb(req.params.id, fileStore);
    if (outcome === 'rejected-no-closed-state') {
      return res.status(409).json({
        error: { code: 'NO_CLOSED_STATE', message: `该类型（${wu.type}，人工验收类）无 closed 状态，不支持关闭；如需继续请回复指导意见` },
      });
    }
    if (outcome !== 'closed') {
      return res.status(409).json({
        error: { code: 'NOT_BLOCKED', message: 'WorkUnit 状态已变化，关闭未完成' },
      });
    }
    const updated = await service.getById(req.params.id);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) } });
  }
});

/** POST /:id/status — transition WorkUnit status (state machine) */
router.post('/:id/status', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!status || typeof status !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'status is required' },
      });
    }

    const wu = await service.transitionStatus(req.params.id, status);
    res.json(wu);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('Invalid status transition')) {
      return res.status(400).json({
        error: { code: 'INVALID_TRANSITION', message: msg },
      });
    }
    if (msg.includes('not found')) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

// ── 讨论空间 (AS-025 §5.16) ──

/** GET /:id/messages — list messages in discussion space (workUnitId grouping) */
router.get('/:id/messages', async (req: Request, res: Response) => {
  try {
    const { before, limit = '50' } = req.query;
    const take = Math.min(Number(limit), 100);

    const beforeDate = before ? new Date(before as string) : undefined;

    const result = await channelMessageService.listByWorkUnitId(req.params.id, {
      before: beforeDate,
      limit: take,
    });

    res.json({
      success: true,
      data: result.data,
      total: result.total,
      hasMore: result.data.length < result.total,
    });
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** POST /:id/messages — send message in discussion space (auto-associate workUnitId) */
router.post('/:id/messages', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { content, replyToId, authorType = 'human', agentName } = req.body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'content is required' },
      });
    }

    // Verify WorkUnit exists
    const wu = await service.getById(req.params.id);
    if (!wu) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `WorkUnit ${req.params.id} not found` },
      });
    }

    // Need a channelId — use WorkUnit's channelId or fallback to system channel
    let channelId = wu.channelId;
    if (!channelId) {
      const rndChannels = await fileStore.listChannels({ type: 'rnd' });
      const sysChannel = rndChannels.length > 0 ? rndChannels[0] : null;
      if (!sysChannel) {
        return res.status(400).json({
          error: { code: 'NO_CHANNEL', message: 'No channel available for discussion messages' },
        });
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
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** PATCH /:id/messages/:messageId — edit message in discussion space */
router.patch('/:id/messages/:messageId', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const { content, meta } = req.body;

    if (content === undefined && meta === undefined) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'content or meta is required' },
      });
    }

    // Verify message belongs to this WorkUnit
    const found = await fileStore.getMessageById(req.params.messageId);
    if (!found) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Message ${req.params.messageId} not found` },
      });
    }
    if (found.message.workUnitId !== req.params.id) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'Message does not belong to this WorkUnit' },
      });
    }

    const updated = await channelMessageService.updateMessage(req.params.messageId, {
      content,
      meta,
    });

    res.json(updated);
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('not found')) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: msg },
      });
    }
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

export default router;
