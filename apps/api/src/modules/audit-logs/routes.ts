// audit-logs/routes.ts - 审计日志 API (AR-012)
//
// 契约驱动迁移（2026-10 批次 6/7）：走 core/http.ts defineRoute——查询参数收进 zod
// （actorType/source 由任意串透传收紧为词表，唯一消费方前端已在词表内；
// POST / action/resource 由透传收紧为必填——缺此二键的落库行即废行）；分页壳
// `{ data, pagination }` 原已同形不变；GET /stats 裸对象与 GET /:id 裸行进
// `{ data }` 壳；GET /export 附件下载 handler 自写 res 不进壳；500 code 由
// 'INTERNAL_ERROR' 归一为 INTERNAL（message 由固定串变为实际错误消息）。
import { Router } from 'express';
import { AuditService, AuditActions, AuditResources } from '@dommaker/studio-audit';
import type { AuditLogInput } from '@dommaker/studio-audit';

import { defineRoute, HttpError, paginated } from '../../core/http.js';
import { ERROR_CODES } from '@dommaker/studio-contract';
import {
  auditLogListQuerySchema,
  auditLogStatsQuerySchema,
  auditLogExportQuerySchema,
  auditLogCreateBodySchema,
  auditLogIdParamsSchema,
} from '@dommaker/studio-contract';
import { parsePagination } from '../../utils/pagination.js';
import { createLazyService } from '../../utils/services.js';
import {
  queryProposalDecisionRows,
  getProposalDecisionRowById,
} from './proposal-source.js';
import { getStore } from '../../core/store.js';


const router = Router();

const getAuditService = createLazyService(() => new AuditService(getStore()));

/** #591：合并操作轨 + 提案源行，统一按 createdAt 降序（list 分页与 export 共用） */
function mergeDecisionRows<T extends { createdAt: string }>(...sources: T[][]): T[] {
  return sources.flat().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function totalPages(total: number, limit: number): number {
  return Math.ceil(total / limit);
}

// ========== API 路由 ==========

/**
 * GET /api/audit-logs - 查询审计日志
 *
 * Query params 见 auditLogListQuerySchema：
 * - source: 来源维度（#591：operation|proposal|all，缺省 operation 保持既有行为）；
 *   含 proposal 时合并 review-proposal 聚合行后统一排序分页
 * - page/limit：#359 起统一走 parsePagination clamp（1..100）
 */
router.get('/', defineRoute(
  { query: auditLogListQuerySchema },
  async (req, _res, { query }) => {
    const service = getAuditService();
    // #359：统一 parsePagination（clamp 1..100），堵 limit=999999 直通豁口；缺省 50→20
    const { page, limit } = parsePagination(req);

    const source = query.source ?? 'operation';
    const baseQuery = {
      userId: query.userId,
      roleId: query.roleId,
      companyId: query.companyId,
      action: query.action,
      resource: query.resource,
      resourceId: query.resourceId,
      status: query.status,
      anonymousId: query.anonymousId,  // 🆕 SEC-009
      actorType: query.actorType,  // #591
      startTime: query.startTime ? new Date(query.startTime) : undefined,
      endTime: query.endTime ? new Date(query.endTime) : undefined,
    };

    if (source === 'proposal' || source === 'all') {
      // #591 A 类：聚合 review-proposal 源，与操作轨合并后统一排序分页（全内存，与 query 同口径）
      const opRows = source === 'all'
        ? (await service.query({ ...baseQuery, page: 1, limit: 10000 })).data
        : [];
      const proposalRows = await queryProposalDecisionRows(baseQuery);
      const merged = mergeDecisionRows(opRows, proposalRows);
      const items = merged.slice((page - 1) * limit, page * limit);
      return paginated(items, { page, limit, total: merged.length, totalPages: totalPages(merged.length, limit) });
    }

    const result = await service.query({ ...baseQuery, page, limit });
    return paginated(result.data, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: totalPages(result.total, result.limit),
    });
  },
));

/**
 * GET /api/audit-logs/stats - 获取审计日志统计
 */
router.get('/stats', defineRoute(
  { query: auditLogStatsQuerySchema },
  async (_req, _res, { query }) => {
    const service = getAuditService();
    return service.getStats({
      startTime: query.startTime ? new Date(query.startTime) : undefined,
      endTime: query.endTime ? new Date(query.endTime) : undefined,
      userId: query.userId,
      companyId: query.companyId,
    });
  },
));

/**
 * GET /api/audit-logs/actions - 获取操作类型列表
 */
router.get('/actions', defineRoute({}, async () => Object.values(AuditActions)));

/**
 * GET /api/audit-logs/resources - 获取资源类型列表
 */
router.get('/resources', defineRoute({}, async () => Object.values(AuditResources)));

/**
 * GET /api/audit-logs/export - 导出审计日志
 *
 * 过滤口径与 GET / 列表一致（E7 前端已带 action/resource/status，
 * 修复前路由层静默丢弃导致假过滤）。
 * 必须注册在 GET /:id 之前——否则 `/export` 被 `/:id` 遮蔽不可达
 * （历史 bug，2026-09-09 随过滤透传一并修复）。
 * 附件下载（Content-Disposition）：handler 自写 res 不进 `{ data }` 壳。
 */
router.get('/export', defineRoute(
  { query: auditLogExportQuerySchema },
  async (_req, res, { query }) => {
    const service = getAuditService();

    const source = query.source ?? 'operation';
    const q = {
      userId: query.userId,
      companyId: query.companyId,
      action: query.action,
      resource: query.resource,
      status: query.status,
      actorType: query.actorType,  // #591
      startTime: query.startTime ? new Date(query.startTime) : undefined,
      endTime: query.endTime ? new Date(query.endTime) : undefined,
    };

    // #591：source 含 proposal 时合并提案源（导出上限与操作轨一致 10000）
    const logs = source === 'operation'
      ? await service.export(q)
      : mergeDecisionRows(
          source === 'all' ? await service.export(q) : [],
          await queryProposalDecisionRows(q),
        ).slice(0, 10000);

    // 设置下载头（自写 res——defineRoute 见 headersSent 不再包壳）
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${new Date().toISOString().split('T')[0]}.json"`);

    res.json(logs);
  },
));

/**
 * GET /api/audit-logs/:id - 获取单条审计日志
 */
router.get('/:id', defineRoute(
  { params: auditLogIdParamsSchema },
  async (_req, _res, { params }) => {
    const service = getAuditService();
    // #591：操作轨未命中时回查 review-proposal 聚合源（提案行 id = 提案 id）
    const log = await service.getById(params.id)
      ?? await getProposalDecisionRowById(params.id);

    if (!log) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Audit log not found');
    }
    return log;
  },
));

/**
 * POST /api/audit-logs - 创建审计日志（201 空体：service.log 返回 void）
 */
router.post('/', defineRoute(
  { body: auditLogCreateBodySchema },
  { status: 201 },
  async (_req, _res, { body }) => {
    const service = getAuditService();
    // 路由边界显式收回（z.infer 在 strict:false 下字段退化可选，schema 已保必填）
    await service.log(body as AuditLogInput);
  },
));

/**
 * #256: POST /api/audit-logs/cleanup 端点下线--硬删 audit 行不归档，绕过 #213
 * 「只增不删」决议。删除语义统一归轮转机制（STUDIO_LOG_FILE_POLICIES
 * 已配置 audit.jsonl: hotDays=90, action=archive）。
 * 若需重新引入清理能力，必须先归档（复用 rotateJsonlLog/appendGz）再删热行。
 */

export default router;
