// Specs API 路由
// SP-002: Spec 变更分级流程

import { Router, Request, Response } from 'express';
import {
  ChangeAnalyzerService,
  ChangeApproverService,
  ChangeHistoryService,
  GateCheckerService,
  changeAnalyzerService,
  changeApproverService,
  changeHistoryService,
  gateCheckerService,
} from '@dommaker/studio-spec';
import { logger } from '@dommaker/studio-shared';
import { parsePagination, sendPaginated } from '../../utils/pagination.js';

const router = Router();

// ========================================
// 变更分析 API
// ========================================

/**
 * POST /api/v1/specs/:id/analyze-change
 * 分析变更级别
 */
router.post('/:id/analyze-change', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { oldVersion, newVersion } = req.body;

    if (!oldVersion || !newVersion) {
      return res.status(400).json({
        error: 'Missing oldVersion or newVersion',
      });
    }

    const result = await changeAnalyzerService.analyze({
      specId: id,
      oldVersion,
      newVersion,
    });

    res.json({
      data: result,
    });
  } catch (error) {
    logger.error('Failed to analyze change', { error: String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================
// 变更提交 API
// ========================================

/**
 * POST /api/v1/specs/:id/submit-change
 * 提交变更
 */
router.post('/:id/submit-change', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { changeContent, changeNote, submittedBy } = req.body;

    if (!changeContent || !submittedBy) {
      return res.status(400).json({
        error: 'Missing changeContent or submittedBy',
      });
    }

    const result = await changeApproverService.submit({
      specId: id,
      changeContent,
      changeNote,
      submittedBy,
    });

    // 保存到历史
    const record = await changeApproverService.get(result.changeId);
    if (record) {
      changeHistoryService.save(record);
    }

    res.json({
      data: result,
    });
  } catch (error) {
    logger.error('Failed to submit change', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/specs/changes/:changeId/approve
 * 审批变更
 */
router.post('/changes/:changeId/approve', async (req: Request, res: Response) => {
  try {
    const { changeId } = req.params;
    const { approvedBy, approved, comment } = req.body;

    if (!approvedBy) {
      return res.status(400).json({
        error: 'Missing approvedBy',
      });
    }

    const result = await changeApproverService.approve({
      changeId,
      approvedBy,
      approved: approved ?? true,
      comment,
    });

    // 更新历史记录
    const record = await changeApproverService.get(changeId);
    if (record) {
      changeHistoryService.save(record);
    }

    res.json({
      data: result,
    });
  } catch (error) {
    logger.error('Failed to approve change', { error: String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/specs/changes/:changeId/apply
 * 应用变更
 */
router.post('/changes/:changeId/apply', async (req: Request, res: Response) => {
  try {
    const { changeId } = req.params;

    const result = await changeApproverService.apply(changeId);

    // 更新历史记录
    const record = await changeApproverService.get(changeId);
    if (record) {
      changeHistoryService.save(record);
    }

    res.json({
      data: result,
    });
  } catch (error) {
    logger.error('Failed to apply change', { error: String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/specs/changes/:changeId
 * 获取变更详情
 */
router.get('/changes/:changeId', async (req: Request, res: Response) => {
  try {
    const { changeId } = req.params;

    const record = changeHistoryService.get(changeId);

    if (!record) {
      return res.status(404).json({ error: 'Change not found' });
    }

    res.json({ data: record });
  } catch (error) {
    logger.error('Failed to get change', { error: String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================
// 门禁验证 API
// ========================================

/**
 * POST /api/v1/specs/changes/:changeId/validate
 * 门禁验证
 */
router.post('/changes/:changeId/validate', async (req: Request, res: Response) => {
  try {
    const { changeId } = req.params;
    const { checkpoints, harnessConfigs, strictMode } = req.body;

    const result = await gateCheckerService.validate({
      changeId,
      checkpoints,
      harnessConfigs,
      strictMode,
    });

    res.json({ data: result });
  } catch (error) {
    logger.error('Failed to validate change', { error: String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/specs/gates/:level
 * 获取门禁策略
 */
router.get('/gates/:level', async (req: Request, res: Response) => {
  try {
    const { level } = req.params;

    const policy = gateCheckerService.getPolicy(level as 'L1' | 'L2' | 'L3' | 'L4');

    res.json({ data: policy });
  } catch (error) {
    logger.error('Failed to get gate policy', { error: String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/specs/gates
 * 获取所有门禁策略
 */
router.get('/gates', async (req: Request, res: Response) => {
  try {
    const policies = gateCheckerService.getAllPolicies();

    res.json({ data: policies });
  } catch (error) {
    logger.error('Failed to get all gate policies', { error: String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================
// 变更历史 API
// ========================================

/**
 * GET /api/v1/specs/:id/changes
 * 获取 Spec 的变更历史
 */
router.get('/:id/changes', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { page, limit, offset } = parsePagination(req);

    const allRecords = changeHistoryService.getHistory(id);
    const total = allRecords.length;
    const records = allRecords.slice(offset, offset + limit);

    sendPaginated(res, records, total, page, limit);
  } catch (error) {
    logger.error('Failed to get change history', { error: String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/specs/:id/changes/stats
 * 获取变更统计
 */
router.get('/:id/changes/stats', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const stats = changeHistoryService.getStats(id);

    res.json({ data: stats });
  } catch (error) {
    logger.error('Failed to get change stats', { error: String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/specs/:id/changes/export
 * 导出变更历史
 */
router.get('/:id/changes/export', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const data = changeHistoryService.export(id);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${id}-changes.json"`);
    res.send(data);
  } catch (error) {
    logger.error('Failed to export change history', { error: String(error) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/specs/:id/changes/import
 * 导入变更历史
 */
router.post('/:id/changes/import', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'Missing data' });
    }

    const count = changeHistoryService.import(id, data);

    res.json({
      data: { imported: count },
    });
  } catch (error) {
    logger.error('Failed to import change history', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;