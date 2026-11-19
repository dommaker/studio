// audit-logs/routes.ts - 审计日志 API (AR-012)
//
// 契约驱动迁移（2026-10 批次 6/7）：走 core/http.ts defineRoute——查询参数收进 zod
// （actorType/source 由任意串透传收紧为词表，唯一消费方前端已在词表内）；
// 分页壳 `{ data, pagination }` 原已同形不变；GET /stats 裸对象进 `{ data }` 壳；
// GET /export 附件下载 handler 自写 res 不进壳；500 code 由
// 'INTERNAL_ERROR' 归一为 INTERNAL（message 由固定串变为实际错误消息）。
// P4.6（2026-10-17）：GET /:id 与 POST / 孤儿端点删除（仓内无消费方；审计写入
// 走 registerAuditSink 直调 service，不经 HTTP）。
import { Router } from 'express';
import { AuditActions, AuditResources, getAuditService } from './audit-service.js';

import { defineRoute, paginated, makePagination } from '../../core/http.js';
import {
  auditLogListQuerySchema,
  auditLogStatsQuerySchema,
  auditLogExportQuerySchema,
  auditLogListResponseSchema,
  auditLogStatsResponseSchema,
  auditLogActionsResponseSchema,
  auditLogResourcesResponseSchema,
} from '@dommaker/studio-contract';
import { parsePagination } from '../../utils/pagination.js';
import { queryProposalDecisionRows } from './proposal-source.js';


const router = Router();

/** #591：合并操作轨 + 提案源行，统一按 createdAt 降序（list 分页与 export 共用） */
function mergeDecisionRows<T extends { createdAt: string }>(...sources: T[][]): T[] {
  return sources.flat().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
  { query: auditLogListQuerySchema, response: auditLogListResponseSchema },
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
      return paginated(items, makePagination(page, limit, merged.length));
    }

    const result = await service.query({ ...baseQuery, page, limit });
    return paginated(result.data, makePagination(result.page, result.limit, result.total));
  },
));
/**
 * GET /api/audit-logs/stats - 获取审计日志统计
 */
router.get('/stats', defineRoute(
  { query: auditLogStatsQuerySchema, response: auditLogStatsResponseSchema },
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
router.get('/actions', defineRoute({ response: auditLogActionsResponseSchema }, async () => Object.values(AuditActions)));

/**
 * GET /api/audit-logs/resources - 获取资源类型列表
 */
router.get('/resources', defineRoute({ response: auditLogResourcesResponseSchema }, async () => Object.values(AuditResources)));

/**
 * GET /api/audit-logs/export - 导出审计日志
 *
 * 过滤口径与 GET / 列表一致（E7 前端已带 action/resource/status，
 * 修复前路由层静默丢弃导致假过滤）。
 * 历史 bug：/export 曾注册在 GET /:id 之后被遮蔽不可达，2026-09-09 修复。
 * （GET /:id 已随 P4.6 删除，遮蔽前提不复存在。）
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
 * #256: POST /api/audit-logs/cleanup 端点下线--硬删 audit 行不归档，绕过 #213
 * 「只增不删」决议。删除语义统一归轮转机制（STUDIO_LOG_FILE_POLICIES
 * 已配置 audit.jsonl: hotDays=90, action=archive）。
 * 若需重新引入清理能力，必须先归档（复用 rotateJsonlLog/appendGz）再删热行。
 */

export default router;
