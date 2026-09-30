// Specs API 路由
// SP-002: Spec 变更分级流程
//
// 契约驱动迁移（2026-10 批次 3/7）：全部端点走 core/http.ts defineRoute——
// oldVersion/newVersion/data 手写 guard 收进 zod；GET /gates/:level 非法 level
// 原 200 空体边缘收紧为 zod 400；统一 envelope（原已带 `{ data }` 壳，形状不变；
// export 附件下载 handler 自写 res 不进壳）。无前端消费方。

import { Router } from 'express';
import {
  specIdParamsSchema,
  changeIdParamsSchema,
  gateLevelParamsSchema,
  listSpecChangesQuerySchema,
  analyzeChangeBodySchema,
  validateChangeBodySchema,
  importChangesBodySchema,
  ERROR_CODES,
  type ChangeLevel,
} from '@dommaker/studio-contract';
import {
  changeAnalyzerService,
  changeHistoryService,
  gateCheckerService,
} from '@dommaker/studio-spec';
import { defineRoute, HttpError, paginated } from '../../core/http.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';

const router = Router();

// ========================================
// 变更分析 API
// ========================================

/**
 * POST /api/v1/specs/:id/analyze-change
 * 分析变更级别
 */
router.post('/:id/analyze-change', defineRoute(
  { params: specIdParamsSchema, body: analyzeChangeBodySchema },
  async (_req, _res, { params, body }) => {
    return changeAnalyzerService.analyze({
      specId: params.id,
      oldVersion: body.oldVersion as never,
      newVersion: body.newVersion as never,
    });
  },
));

// ========================================
// 变更提交 API（已删除 - SpecChangeRequest 表移除）
// ========================================

/**
 * GET /api/v1/specs/changes/:changeId
 * 获取变更详情
 */
router.get('/changes/:changeId', defineRoute(
  { params: changeIdParamsSchema },
  async (_req, _res, { params }) => {
    const record = changeHistoryService.get(params.changeId);
    if (!record) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Change not found');
    return record;
  },
));

// ========================================
// 门禁验证 API
// ========================================

/**
 * POST /api/v1/specs/changes/:changeId/validate
 * 门禁验证
 */
router.post('/changes/:changeId/validate', requireAuth(), requireNotGuest(), defineRoute(
  { params: changeIdParamsSchema, body: validateChangeBodySchema },
  async (_req, _res, { params, body }) => {
    const { checkpoints, harnessConfigs, strictMode } = body;
    return gateCheckerService.validate({
      changeId: params.changeId,
      checkpoints: checkpoints as never,
      harnessConfigs: harnessConfigs as never,
      strictMode,
    });
  },
));

/**
 * GET /api/v1/specs/gates/:level
 * 获取门禁策略
 */
router.get('/gates/:level', defineRoute(
  { params: gateLevelParamsSchema },
  async (_req, _res, { params }) => {
    return gateCheckerService.getPolicy(params.level as ChangeLevel);
  },
));

/**
 * GET /api/v1/specs/gates
 * 获取所有门禁策略
 */
router.get('/gates', defineRoute({}, async () => {
  return gateCheckerService.getAllPolicies();
}));

// ========================================
// 变更历史 API
// ========================================

/**
 * GET /api/v1/specs/:id/changes
 * 获取 Spec 的变更历史
 */
router.get('/:id/changes', defineRoute(
  { params: specIdParamsSchema, query: listSpecChangesQuerySchema },
  async (_req, _res, { params, query }) => {
    // 与 utils/pagination.ts parsePagination 同口径（clamp 1..100，缺省 1/20）
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '20', 10) || 20));
    const offset = (page - 1) * limit;

    const allRecords = changeHistoryService.getHistory(params.id);
    const total = allRecords.length;
    const records = allRecords.slice(offset, offset + limit);

    return paginated(records, { page, limit, total, totalPages: Math.ceil(total / limit) });
  },
));

/**
 * GET /api/v1/specs/:id/changes/stats
 * 获取变更统计
 */
router.get('/:id/changes/stats', defineRoute(
  { params: specIdParamsSchema },
  async (_req, _res, { params }) => {
    return changeHistoryService.getStats(params.id);
  },
));

/**
 * GET /api/v1/specs/:id/changes/export
 * 导出变更历史（附件下载，handler 自写 res 不进 envelope）
 */
router.get('/:id/changes/export', defineRoute(
  { params: specIdParamsSchema },
  async (_req, res, { params }) => {
    const data = changeHistoryService.export(params.id);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${params.id}-changes.json"`);
    res.send(data);
    return undefined;
  },
));

/**
 * POST /api/v1/specs/:id/changes/import
 * 导入变更历史
 */
router.post('/:id/changes/import', requireAuth(), requireNotGuest(), defineRoute(
  { params: specIdParamsSchema, body: importChangesBodySchema },
  async (_req, _res, { params, body }) => {
    const count = changeHistoryService.import(params.id, body.data!);
    return { imported: count };
  },
));

export default router;
