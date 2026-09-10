/**
 * 行动中心 API 路由（#468）
 *
 * GET / — 状态派生（reply/review/confirm）+ 事件持久（notifications）+ unreadCount。
 * 鉴权形态与 modules/notifications/routes.ts 一致：requireAuth + requireNotGuest，
 * 身份取登录态 JWT claims（req.user.id）。
 */

import { Router, Request, Response } from 'express';
import { logger } from '@dommaker/studio-shared';
import { createLazyService } from '../../utils/services.js';
import { requireAuth, requireNotGuest, AuthRequest } from '../../middleware/auth.js';
import { ActionCenterService } from './action-center.service.js';

const router = Router();

const getActionCenterService = createLazyService(() => new ActionCenterService());

/**
 * GET /api/v1/action-center
 * 统一行动中心：四类待办一个端点（待回复/待验收/待确认 + 通知与告警）
 */
router.get('/', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).user?.id ?? null;
    if (!userId) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Authenticated user missing' } });
      return;
    }
    res.json(await getActionCenterService().getActionCenter(userId));
  } catch (error) {
    logger.error('Failed to get action center', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get action center' } });
  }
});

export { router as actionCenterRoutes };
