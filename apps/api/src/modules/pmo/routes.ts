// PMO API Routes - 项目管理办公室
//
// 契约驱动迁移（2026-10 批次 2/7）：全部端点走 core/http.ts defineRoute——
// zod 校验入参（title/status/channelId/command/commit/companyId/deliveryPolicy/gitRepos
// 等手写 guard 收进 schema）、统一 envelope（{ data }）、错误映射 options.errors。
// 鉴权挂载保持原样（requireAuth/requireNotGuest/requireRole 声明式统一是 Phase 2 的事）；
// local 复制的 authorType 守卫删除，改用 core/http.ts 的 requireHuman（deliver/mark-delivered
// human-only，挂在 defineRoute 之前读原始 body.authorType）。
// deliver/mark-delivered 的 409 拒绝体带 missing/conflictFiles 扩展字段（前端 DeliveryPanel
// 消费），HttpError 承载不了 → handler 自写 res（defineRoute 见 headersSent 跳过代写）。
import { Router } from 'express';
import {
  listProjectsQuerySchema,
  listOkrsQuerySchema,
  projectIdParamsSchema,
  pmoNumberParamsSchema,
  okrIdParamsSchema,
  createProjectBodySchema,
  updateProjectBodySchema,
  updateProjectStatusBodySchema,
  publishProjectBodySchema,
  parsePmoCommandBodySchema,
  markDeliveredBodySchema,
  createOkrBodySchema,
  updateOkrBodySchema,
  ERROR_CODES,
} from '@dommaker/studio-contract';
import { okrService, type UpdateOKRInput } from './okr.service.js';
import { projectService, parsePmoNumberFromCommand, type UpdateProjectInput } from './project.service.js';
import { getDeliveryStatus, deliverProject, markProjectDelivered } from './delivery.js';
import { syncProjectProgress } from './progress-rollup.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, requireNotGuest, requireRole, type AuthRequest } from '../../middleware/auth.js';  // 🆕 SEC-001 / SEC-002
import { apiCache, CACHE_CONFIG, clearCache } from '../../middleware/api-cache.js';
import { defineRoute, HttpError, requireHuman } from '../../core/http.js';
import * as fs from 'fs';
import * as path from 'path';
import { parsePagination } from '../../utils/pagination.js';

const router = Router();

/** deliver/mark-delivered 共用的 human-only 守卫文案（原内联守卫同款） */
const DELIVERY_HUMAN_ONLY_MESSAGE = 'Delivery is human-only (authorType=agent rejected)';

// ─── gitRepo 白名单（2026-08-25 安全收口） ───
// gitRepo 会被下游 git 操作（deliver/merge、spec 物化、agent-loop 执行根）消费，
// 写入前必须限制在允许的根目录之下，防任意路径入项目配置。

/**
 * 收集请求里的 gitRepo/gitRepos 候选（仅非空字符串；空串视为未传，与既有口径一致）
 */
function collectGitRepos(gitRepo: unknown, gitRepos: unknown): string[] {
  const repos: string[] = [];
  if (typeof gitRepo === 'string' && gitRepo.trim()) repos.push(gitRepo);
  if (Array.isArray(gitRepos)) {
    for (const r of gitRepos) if (typeof r === 'string' && r.trim()) repos.push(r);
  }
  return repos;
}

/**
 * gitRepo 白名单校验：path.resolve 后必须落在允许的根目录
 * （PMO_GIT_REPO_ROOTS 冒号分隔多根，缺省 /root/projects）之下且为已存在目录。
 * 合法返回 null，否则返回错误消息。
 */
export function validateGitRepo(repo: string): string | null {
  const roots = (process.env.PMO_GIT_REPO_ROOTS || '/root/projects')
    .split(':').map(r => r.trim()).filter(Boolean);
  const resolved = path.resolve(repo);
  const allowed = roots.some(root => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
  if (!allowed || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return `gitRepo must be an existing directory under an allowed root (${roots.join(':')}), got: ${repo}`;
  }
  return null;
}

/** gitRepo/gitRepos 白名单守卫（POST/PUT 共用；失败抛 HttpError 400 INVALID_INPUT，文案不变） */
function assertGitReposAllowed(body: { gitRepo?: unknown; gitRepos?: unknown }): void {
  for (const repo of collectGitRepos(body.gitRepo, body.gitRepos)) {
    const invalid = validateGitRepo(repo);
    if (invalid) throw new HttpError(400, 'INVALID_INPUT', invalid);
  }
}

// ============================================
// Project API（GEN-005）
// ============================================

/**
 * GET /api/v1/pmo/project
 * 获取项目列表（limit/page 走 parsePagination clamp 1..100，缺省 20 与既有口径一致）
 */
router.get('/project', defineRoute({ query: listProjectsQuerySchema }, async (req, _res, { query }) => {
  // #359：统一 parsePagination（clamp 1..100），缺省 20 与既有口径一致
  const { limit } = parsePagination(req);
  return projectService.list({
    status: query.status,
    priority: query.priority,
    okrId: query.okrId,
    limit,
  });
}));

/**
 * POST /api/v1/pmo/project
 * 创建项目（自动生成 PMO 号）
 */
router.post('/project', requireAuth(), requireNotGuest(), defineRoute(
  { body: createProjectBodySchema },
  { status: 201 },
  async (_req, _res, { body }) => {
    assertGitReposAllowed(body);
    return projectService.create({
      companyId: body.companyId,
      title: body.title,
      description: body.description,
      requirement: body.requirement,
      okrId: body.okrId,
      priority: body.priority,
      gitBranch: body.gitBranch,
      gitRepo: body.gitRepo,
      gitRepos: body.gitRepos,
      deliveryPolicy: body.deliveryPolicy,
      requirementsDocId: body.requirementsDocId,
    });
  },
));

/**
 * GET /api/v1/pmo/project/by-pmo/:pmoNumber
 * 通过 PMO 号获取项目（须注册在 /project/:id 之前，防止 by-pmo 被 :id 吞掉——旧路由顺序如此）
 */
router.get('/project/by-pmo/:pmoNumber', defineRoute({ params: pmoNumberParamsSchema }, async (_req, _res, { params }) => {
  const project = await projectService.getByPmoNumber(params.pmoNumber);
  if (!project) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Project not found');
  return project;
}));

/**
 * GET /api/v1/pmo/project/:id
 * 获取项目详情
 */
router.get('/project/:id', defineRoute({ params: projectIdParamsSchema }, async (req, _res, { params }) => {
  // 读取时重算进度（best-effort）：analysis 派生链无 Requirement 归属，事件入口此前接不上，存量项目进度滞留
  await syncProjectProgress(params.id).catch(err =>
    logger.warn({ projectId: params.id, error: String(err) }, '[PMO] Progress resync on read failed (non-blocking)'));
  const project = await projectService.get(params.id);
  if (!project) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Project not found');
  return project;
}));

/**
 * GET /api/v1/pmo/project/:id/delivery
 * PMO-b：交付台账（WU 汇总 + 证据齐缺 + deliverable 标记；branch-only 交付的就是这份回答）
 */
router.get('/project/:id/delivery', defineRoute({ params: projectIdParamsSchema }, async (_req, _res, { params }) => {
  const status = await getDeliveryStatus(params.id);
  if (!status) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Project not found');
  return status;
}));

/**
 * POST /api/v1/pmo/project/:id/deliver
 * PMO-b：auto-merge 交付（human-only）——证据齐才把 PMO 分支合入默认分支（本地，不 push）。
 * 缺证据 409 硬拒；branch-only 409 并附分支名（交付动作在下游发布链路，studio 不碰）。
 */
router.post('/project/:id/deliver', requireAuth(), requireNotGuest(), requireHuman(DELIVERY_HUMAN_ONLY_MESSAGE), defineRoute(
  { params: projectIdParamsSchema },
  async (req, res, { params }) => {
    const user = (req as AuthRequest).user;
    const outcome = await deliverProject(params.id, user?.name ?? user?.email ?? user?.id ?? 'human');
    // 注：本包 tsconfig 未开 strict，可辨识联合须用 === 字面量比较收窄（merge-on-review-pass 同款）
    if (outcome.delivered === true) {
      return { delivered: true as const, deliverCommit: outcome.deliverCommit, ...(outcome.legs ? { legs: outcome.legs } : {}) };
    }
    if (outcome.reason === 'not-found') {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Project not found');
    }
    // 409 拒绝体带 missing/conflictFiles 扩展（前端 DeliveryPanel 消费）——HttpError 承载不了，自写 res
    res.status(409).json({
      error: {
        code: outcome.reason.toUpperCase().replace(/-/g, '_'),
        message: outcome.detail ?? outcome.reason,
        missing: outcome.missing,
        conflictFiles: outcome.conflictFiles,
      },
    });
    return undefined;
  },
));

/**
 * POST /api/v1/pmo/project/:id/mark-delivered
 * #469：branch-only 人工落档（human-only）——系统外合并后把 commit 哈希写进台账
 * （deliveredAt/deliveredBy/deliverCommit），交付闭环在系统内留痕。commit 必填（400）；
 * auto-merge 项目 / 已落档 → 409。
 */
router.post('/project/:id/mark-delivered', requireAuth(), requireNotGuest(), requireHuman(DELIVERY_HUMAN_ONLY_MESSAGE), defineRoute(
  { params: projectIdParamsSchema, body: markDeliveredBodySchema },
  async (req, res, { params, body }) => {
    const user = (req as AuthRequest).user;
    const outcome = await markProjectDelivered(params.id, user?.name ?? user?.email ?? user?.id ?? 'human', body.commit);
    // 注：本包 tsconfig 未开 strict，可辨识联合须用 === 字面量比较收窄（deliver 路由同款）
    if (outcome.marked === true) {
      return { delivered: true as const, deliverCommit: outcome.deliverCommit, deliveredAt: outcome.deliveredAt };
    }
    if (outcome.reason === 'not-found') {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Project not found');
    }
    res.status(409).json({
      error: {
        code: outcome.reason.toUpperCase().replace(/-/g, '_'),
        message: outcome.detail ?? outcome.reason,
      },
    });
    return undefined;
  },
));

/**
 * PUT /api/v1/pmo/project/:id
 * 更新项目（service 整体展开 body；'Project not found' 等服务错误旧行为即 500，保持不映射）
 */
router.put('/project/:id', requireAuth(), requireNotGuest(), defineRoute(
  { params: projectIdParamsSchema, body: updateProjectBodySchema },
  async (_req, _res, { params, body }) => {
    assertGitReposAllowed(body);
    // z.infer 在本仓 strict:false 下嵌套字段退化可选（contract CONTEXT.md 坑①），
    // body 已过 zod 形状校验，路由边界显式收回为 service 入参类型
    return projectService.update(params.id, body as UpdateProjectInput);
  },
));

/**
 * PUT /api/v1/pmo/project/:id/status
 * 更新项目状态（状态机非法迁移/不存在旧行为即 500，保持不映射）
 */
router.put('/project/:id/status', requireAuth(), requireNotGuest(), defineRoute(
  { params: projectIdParamsSchema, body: updateProjectStatusBodySchema },
  async (_req, _res, { params, body }) => {
    return projectService.updateStatus(params.id, body.status);
  },
));

/**
 * DELETE /api/v1/pmo/project/:id
 * 删除项目（仅 pending/cancelled 状态）
 * 🆕 SEC-002: Admin only
 */
router.delete('/project/:id', requireRole('Admin'), defineRoute(
  { params: projectIdParamsSchema },
  {
    errors: [
      { match: 'Project not found', status: 400, code: ERROR_CODES.BAD_REQUEST },
      { match: 'Can only delete', status: 400, code: ERROR_CODES.BAD_REQUEST },
    ],
  },
  async (_req, _res, { params }) => {
    return projectService.delete(params.id);
  },
));

/**
 * POST /api/v1/pmo/project/:id/publish
 * 发布 PMO 到 Channel，创建 plan WorkUnit
 */
router.post('/project/:id/publish', requireAuth(), requireNotGuest(), defineRoute(
  { params: projectIdParamsSchema, body: publishProjectBodySchema },
  {
    errors: [
      // 旧行为：'not found'/'pending' → 400，其余 500（顺序不敏感，两者不互含）
      { match: 'not found', status: 400, code: ERROR_CODES.BAD_REQUEST },
      { match: 'pending', status: 400, code: ERROR_CODES.BAD_REQUEST },
    ],
  },
  async (_req, _res, { params, body }) => {
    const result = await projectService.publish({
      projectId: params.id,
      channelId: body.channelId,
      // #177：可选 assigneeId（profile id）落 analysis WU；留空 = 回池涌现
      ...(body.assigneeId?.trim() ? { assigneeId: body.assigneeId.trim() } : {}),
    });
    return result;
  },
));

/**
 * GET /api/v1/pmo/project/:id/sdd
 * 查询与 PMO 关联的 SDD 条目
 */
router.get('/project/:id/sdd', defineRoute(
  { params: projectIdParamsSchema },
  { errors: [{ match: 'not found', status: 404, code: ERROR_CODES.NOT_FOUND }] },
  async (_req, _res, { params }) => {
    return projectService.getLinkedSDDs(params.id);
  },
));

/**
 * POST /api/v1/pmo/project/parse-command
 * 解析 CEO 指令中的 PMO 号
 */
router.post('/project/parse-command', defineRoute({ body: parsePmoCommandBodySchema }, async (_req, _res, { body }) => {
  return parsePmoNumberFromCommand(body.command);
}));

// ============================================
// OKR API
// ============================================

/**
 * GET /api/v1/pmo/okr
 * 获取 OKR 列表
 */
router.get('/okr', apiCache(CACHE_CONFIG.medium), defineRoute({ query: listOkrsQuerySchema }, async (_req, _res, { query }) => {
  return okrService.list(query.companyId, { status: query.status });
}));

/**
 * POST /api/v1/pmo/okr
 * 创建 OKR（需要管理员权限；每季度唯一约束撞重 → 409）
 */
router.post('/okr', requireAuth(), requireNotGuest(), defineRoute(
  { body: createOkrBodySchema },
  {
    status: 201,
    errors: [{ match: 'already exists', status: 409, code: ERROR_CODES.CONFLICT }],
  },
  async (req, _res, { body }) => {
    const okr = await okrService.create({
      companyId: body.companyId,
      title: body.title,
      // z.infer 嵌套退化可选（坑①），body 已过 zod，路由边界 map + as 收回必填
      objectives: body.objectives.map(o => ({ ...o, id: o.id as string, title: o.title as string })),
      keyResults: body.keyResults.map(kr => ({
        ...kr,
        id: kr.id as string,
        objectiveId: kr.objectiveId as string,
        title: kr.title as string,
        target: kr.target as number,
        current: kr.current as number,
        unit: kr.unit as string,
      })),
      quarter: body.quarter,
    });
    // #448 问题1：写后失效 OKR 列表缓存（30s apiCache）
    await clearCache(`${req.baseUrl}/okr`);
    return okr;
  },
));

/**
 * GET /api/v1/pmo/okr/:id
 * 获取 OKR 详情
 */
router.get('/okr/:id', defineRoute(
  { params: okrIdParamsSchema },
  { errors: [{ match: 'OKR not found', status: 404, code: ERROR_CODES.NOT_FOUND }] },
  async (_req, _res, { params }) => {
    return okrService.get(params.id);
  },
));

/**
 * PUT /api/v1/pmo/okr/:id
 * 更新 OKR（'OKR not found' 旧行为即 500，保持不映射）
 */
router.put('/okr/:id', requireAuth(), requireNotGuest(), defineRoute(
  { params: okrIdParamsSchema, body: updateOkrBodySchema },
  async (req, _res, { params, body }) => {
    // z.infer 嵌套退化可选（坑①），body 已过 zod，路由边界显式收回为 service 入参类型
    const input: UpdateOKRInput = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.objectives
        ? { objectives: body.objectives.map(o => ({ ...o, id: o.id as string, title: o.title as string })) }
        : {}),
      ...(body.keyResults
        ? {
            keyResults: body.keyResults.map(kr => ({
              ...kr,
              id: kr.id as string,
              objectiveId: kr.objectiveId as string,
              title: kr.title as string,
              target: kr.target as number,
              current: kr.current as number,
              unit: kr.unit as string,
            })),
          }
        : {}),
    };
    const updated = await okrService.update(params.id, input);
    // #448 问题1：写后失效 OKR 列表缓存（30s apiCache）
    await clearCache(`${req.baseUrl}/okr`);
    return updated;
  },
));

/**
 * DELETE /api/v1/pmo/okr/:id
 * 删除 OKR（需要管理员权限；服务错误旧行为即 500，保持不映射）
 * 🆕 SEC-002: Admin only
 */
router.delete('/okr/:id', requireRole('Admin'), defineRoute(
  { params: okrIdParamsSchema },
  async (req, _res, { params }) => {
    const result = await okrService.delete(params.id);
    // #448 问题1：写后失效 OKR 列表缓存（30s apiCache）
    await clearCache(`${req.baseUrl}/okr`);
    return result;
  },
));

export default router;
