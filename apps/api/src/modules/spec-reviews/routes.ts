/**
 * Spec 审查 API 路由
 * 
 * 包含：
 * - Spec 审查 (reviews)
 * - Spec 绕过审批 (bypasses)
 */

import { Router, Request, Response } from 'express';
import { specReviewService } from './spec-review.service.js';
import { logger } from '@dommaker/studio-shared';

const router = Router();

/**
 * GET /api/v1/spec-reviews
 * 获取审查列表
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, limit, offset } = req.query;

    const result = await specReviewService.getReviews({
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
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      title,
      description,
      changes,
      requestedBy,
    } = req.body;

    if (!title || !changes || !Array.isArray(changes)) {
      return res.status(400).json({ error: '缺少必要字段：title, changes' });
    }

    const review = await specReviewService.createReview({
      title,
      description,
      changes,
      requestedBy,
    });

    res.status(201).json(review);
  } catch (error) {
    logger.error('Failed to create spec review', { error: String(error) });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * PATCH /api/v1/spec-reviews/:id
 * 更新审查状态
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: '缺少更新字段：status' });
    }

    const review = await specReviewService.updateReview(req.params.id, {
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

export { router as specReviewRoutes };
