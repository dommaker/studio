/**
 * Spec 审查 API 路由
 * 
 * 包含：
 * - Spec 审查 (reviews)
 * - Spec 绕过审批 (bypasses)
 */

import { Router, Request, Response } from 'express';
import { specReviewService } from './spec-review.service.js';
import { getSpecBypassService, getSpecVersionService } from '@dommaker/studio-spec';

const specBypassService = getSpecBypassService();
const specVersionService = getSpecVersionService();
import { logger } from '@dommaker/studio-shared';

const router = Router();

/**
 * GET /api/v1/spec-reviews
 * 获取审查列表
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { workflowId, status, limit, offset } = req.query;
    
    const result = await specReviewService.getReviews({
      workflowId: workflowId as string,
      status: status as string,
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });
    
    res.json({
      reviews: result.reviews,
      total: result.total,
    });
  } catch (error) {
    logger.error('Failed to get spec reviews', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/spec-reviews/:id
 * 获取审查详情
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const review = await specReviewService.getReview(req.params.id);
    
    if (!review) {
      return res.status(404).json({ error: '审查不存在' });
    }
    
    res.json(review);
  } catch (error) {
    logger.error('Failed to get spec review', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/spec-reviews
 * 创建审查
 * 
 * 🆕 GEN-006: 支持 createMeeting 参数
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { 
      workflowId, 
      title, 
      description, 
      changes, 
      requestedBy,
      createMeeting,  // 🆕 GEN-006
      companyId,      // 🆕 GEN-006
      participantIds  // 🆕 GEN-006
    } = req.body;
    
    if (!title || !changes || !Array.isArray(changes)) {
      return res.status(400).json({ error: '缺少必要字段：title, changes' });
    }
    
    // 🆕 GEN-006: 如果要创建 Meeting，必须有 companyId
    if (createMeeting && !companyId) {
      return res.status(400).json({ error: '创建 Meeting 需要提供 companyId' });
    }
    
    const review = await specReviewService.createReview({
      workflowId,
      title,
      description,
      changes,
      requestedBy,
      createMeeting,   // 🆕 GEN-006
      companyId,       // 🆕 GEN-006
      participantIds,  // 🆕 GEN-006
    });
    
    res.status(201).json(review);
  } catch (error) {
    logger.error('Failed to create spec review', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * 🆕 GEN-006: PATCH /api/v1/spec-reviews/:id
 * 更新审查（如更新 meetingId）
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { meetingId, status } = req.body;
    
    // 验证至少有一个更新字段
    if (!meetingId && !status) {
      return res.status(400).json({ error: '缺少更新字段：meetingId 或 status' });
    }
    
    // 如果更新 meetingId，验证 Meeting 存在
    if (meetingId) {
      const meeting = await req.app.locals.prisma.meeting.findUnique({
        where: { id: meetingId },
      });
      
      if (!meeting) {
        return res.status(404).json({ error: 'Meeting 不存在' });
      }
    }
    
    const review = await specReviewService.updateReview(req.params.id, {
      meetingId,
      status,
    });
    
    res.json(review);
  } catch (error) {
    logger.error('Failed to update spec review', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/spec-reviews/:id/approve
 * 提交审批
 */
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const { role, reviewerId, reviewerName, approved, comment } = req.body;
    
    if (!role || !['architect', 'projectLead'].includes(role)) {
      return res.status(400).json({ error: '无效的角色，必须是 architect 或 projectLead' });
    }
    
    if (!reviewerId || typeof approved !== 'boolean') {
      return res.status(400).json({ error: '缺少必要字段：reviewerId, approved' });
    }
    
    const result = await specReviewService.submitApproval({
      reviewId: req.params.id,
      role,
      reviewerId,
      reviewerName: reviewerName || '未知用户',
      approved,
      comment,
    });
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to submit approval', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============ Spec Bypass Routes ============

/**
 * GET /api/v1/spec-reviews/bypasses
 * 获取绕过列表（默认返回待处理）
 */
router.get('/bypasses', async (req: Request, res: Response) => {
  try {
    const result = await specBypassService.getPendingBypasses();
    res.json(result);
  } catch (error) {
    logger.error('Failed to get bypasses', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/spec-reviews/bypasses/stats
 * 获取绕过统计
 */
router.get('/bypasses/stats', async (req: Request, res: Response) => {
  try {
    const stats = await specBypassService.getBypassStats();
    res.json(stats);
  } catch (error) {
    logger.error('Failed to get bypass stats', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/spec-reviews/bypasses/pending
 * 获取待处理绕过申请
 */
router.get('/bypasses/pending', async (req: Request, res: Response) => {
  try {
    const { limit, offset } = req.query;
    const result = await specBypassService.getPendingBypasses({
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });
    res.json(result);
  } catch (error) {
    logger.error('Failed to get pending bypasses', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/spec-reviews/bypasses/incomplete
 * 获取待补齐绕过申请
 */
router.get('/bypasses/incomplete', async (req: Request, res: Response) => {
  try {
    const { requestedBy, limit, offset } = req.query;
    const result = await specBypassService.getApprovedBypasses({
      requestedBy: requestedBy as string,
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });
    res.json(result);
  } catch (error) {
    logger.error('Failed to get incomplete bypasses', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/spec-reviews/bypasses/:bypassId
 * 获取绕过详情
 */
router.get('/bypasses/:bypassId', async (req: Request, res: Response) => {
  try {
    const bypass = await specBypassService.getBypass(req.params.bypassId);
    if (!bypass) {
      return res.status(404).json({ error: '绕过申请不存在' });
    }
    res.json(bypass);
  } catch (error) {
    logger.error('Failed to get bypass', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/spec-reviews/bypasses
 * 创建绕过申请
 */
router.post('/bypasses', async (req: Request, res: Response) => {
  try {
    const { reason, urgency, requestedBy, requestedName } = req.body;
    
    if (!reason || !urgency || !requestedBy) {
      return res.status(400).json({ error: '缺少必要字段：reason, urgency, requestedBy' });
    }
    
    if (!['critical', 'high', 'medium'].includes(urgency)) {
      return res.status(400).json({ error: 'urgency 必须是 critical, high 或 medium' });
    }
    
    const bypass = await specBypassService.createBypass({
      reason,
      urgency,
      requestedBy,
      requestedName,
    });
    
    res.status(201).json(bypass);
  } catch (error) {
    logger.error('Failed to create bypass', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/spec-reviews/bypasses/:bypassId/approve
 * 审批绕过申请
 */
router.post('/bypasses/:bypassId/approve', async (req: Request, res: Response) => {
  try {
    const { approvedBy, approvedName, approved, comment } = req.body;
    
    if (!approvedBy || typeof approved !== 'boolean') {
      return res.status(400).json({ error: '缺少必要字段：approvedBy, approved' });
    }
    
    const result = await specBypassService.approveBypass({
      bypassId: req.params.bypassId,
      approvedBy,
      approvedName: approvedName || '未知用户',
      approved,
      comment,
    });
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to approve bypass', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/spec-reviews/bypasses/:bypassId/complete
 * 补齐正式审批
 */
router.post('/bypasses/:bypassId/complete', async (req: Request, res: Response) => {
  try {
    const { specReviewId } = req.body;
    
    if (!specReviewId) {
      return res.status(400).json({ error: '缺少必要字段：specReviewId' });
    }
    
    const result = await specBypassService.completeBypass({
      bypassId: req.params.bypassId,
      specReviewId,
    });
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to complete bypass', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============ Spec Version Routes ============

/**
 * GET /api/v1/spec-reviews/:reviewId/versions
 * 获取版本历史
 */
router.get('/:reviewId/versions', async (req: Request, res: Response) => {
  try {
    const { limit, offset } = req.query;
    const result = await specVersionService.getVersionHistory(req.params.reviewId, {
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });
    res.json(result);
  } catch (error) {
    logger.error('Failed to get version history', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/spec-reviews/:reviewId/versions/latest
 * 获取最新版本
 */
router.get('/:reviewId/versions/latest', async (req: Request, res: Response) => {
  try {
    const version = await specVersionService.getLatestVersion(req.params.reviewId);
    if (!version) {
      return res.status(404).json({ error: '暂无版本记录' });
    }
    res.json(version);
  } catch (error) {
    logger.error('Failed to get latest version', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/spec-reviews/:reviewId/versions/:version
 * 获取特定版本
 */
router.get('/:reviewId/versions/:version', async (req: Request, res: Response) => {
  try {
    const version = parseInt(req.params.version);
    if (isNaN(version)) {
      return res.status(400).json({ error: '无效的版本号' });
    }
    
    const result = await specVersionService.getVersion(req.params.reviewId, version);
    if (!result) {
      return res.status(404).json({ error: '版本不存在' });
    }
    res.json(result);
  } catch (error) {
    logger.error('Failed to get version', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/spec-reviews/:reviewId/versions/compare
 * 版本对比
 */
router.get('/:reviewId/versions/compare', async (req: Request, res: Response) => {
  try {
    const { v1, v2 } = req.query;
    
    if (!v1 || !v2) {
      return res.status(400).json({ error: '缺少必要字段：v1, v2' });
    }
    
    const result = await specVersionService.compareVersions(
      req.params.reviewId,
      parseInt(v1 as string),
      parseInt(v2 as string)
    );
    res.json(result);
  } catch (error) {
    logger.error('Failed to compare versions', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/spec-reviews/:reviewId/versions/stats
 * 获取版本变更统计
 */
router.get('/:reviewId/versions/stats', async (req: Request, res: Response) => {
  try {
    const stats = await specVersionService.getVersionStats(req.params.reviewId);
    res.json(stats);
  } catch (error) {
    logger.error('Failed to get version stats', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/spec-reviews/:reviewId/versions
 * 创建版本快照
 */
router.post('/:reviewId/versions', async (req: Request, res: Response) => {
  try {
    const { content, changeType, changeDesc, createdBy, createdName } = req.body;
    
    if (!content || !changeType || !createdBy) {
      return res.status(400).json({ error: '缺少必要字段：content, changeType, createdBy' });
    }
    
    const version = await specVersionService.createVersion({
      reviewId: req.params.reviewId,
      content,
      changeType,
      changeDesc,
      createdBy,
      createdName,
    });
    
    res.status(201).json(version);
  } catch (error) {
    logger.error('Failed to create version', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/v1/spec-reviews/:reviewId/versions/:version/rollback
 * 版本回滚
 */
router.post('/:reviewId/versions/:version/rollback', async (req: Request, res: Response) => {
  try {
    const { createdBy, createdName, reason } = req.body;
    const targetVersion = parseInt(req.params.version);
    
    if (!createdBy || isNaN(targetVersion)) {
      return res.status(400).json({ error: '缺少必要字段：createdBy 或版本号无效' });
    }
    
    const version = await specVersionService.rollbackToVersion(
      req.params.reviewId,
      targetVersion,
      { createdBy, createdName, reason }
    );
    
    res.json(version);
  } catch (error) {
    logger.error('Failed to rollback version', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

export { router as specReviewRoutes };
