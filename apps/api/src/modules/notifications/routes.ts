/**
 * 通知 API 路由
 *
 * #274: 身份源从 x-user-id header 切换为登录态 JWT claims（req.user.id），
 * 读写端点鉴权行为一致（requireAuth + requireNotGuest）。
 * 挂载层（route-registry /api/v1/notifications）另有 requireAuth，此处为端点级自持。
 */

import { Router, Request, Response } from 'express';
import { NotificationService } from '@dommaker/studio-notification';
import { FileStore, logger } from '@dommaker/studio-shared';
import { createLazyService } from '../../utils/services.js';
import { requireAuth, requireNotGuest, AuthRequest } from '../../middleware/auth.js';

const router = Router();

const getNotificationService = createLazyService(() => new NotificationService(new FileStore()));

/**
 * 取登录态用户 id；缺失（鉴权放行但 user 未挂）回 500 并返回 null
 */
function resolveUserId(req: Request, res: Response): string | null {
  const userId = (req as AuthRequest).user?.id ?? null;
  if (!userId) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Authenticated user missing' } });
  }
  return userId;
}

/**
 * GET /api/v1/notifications
 * 获取通知列表
 */
router.get('/', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const unreadOnly = req.query.unreadOnly === 'true';

    const notifications = await getNotificationService().getUserNotifications(userId, {
      unreadOnly,
      limit: 50,
    });

    res.json(notifications);
  } catch (error) {
    logger.error('Failed to get notifications', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get notifications' } });
  }
});

/**
 * GET /api/v1/notifications/unread-count
 * 获取未读数量
 */
router.get('/unread-count', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;

    const count = await getNotificationService().getUnreadCount(userId);

    res.json({ count });
  } catch (error) {
    logger.error('Failed to get unread count', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get unread count' } });
  }
});

/**
 * POST /api/v1/notifications/:id/read
 * 标记已读
 */
router.post('/:id/read', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;

    await getNotificationService().markAsRead(req.params.id, userId);

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to mark as read', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to mark as read' } });
  }
});

/**
 * POST /api/v1/notifications/read-all
 * 标记全部已读
 */
router.post('/read-all', requireAuth(), requireNotGuest(), async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;

    await getNotificationService().markAllAsRead(userId);

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to mark all as read', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to mark all as read' } });
  }
});

export { router as notificationRoutes };
