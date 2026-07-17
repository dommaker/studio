/**
 * 通知 API 路由
 */

import { Router, Request, Response } from 'express';
import { NotificationService } from '@dommaker/studio-notification';
import { FileStore, logger } from '@dommaker/studio-shared';
import { createLazyService } from '../../utils/services.js';

const router = Router();

const getNotificationService = createLazyService(() => new NotificationService(new FileStore()));

/**
 * GET /api/v1/notifications
 * 获取通知列表
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req.headers['x-user-id'] as string) || 'default-user';
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
router.get('/unread-count', async (req: Request, res: Response) => {
  try {
    const userId = (req.headers['x-user-id'] as string) || 'default-user';

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
router.post('/:id/read', async (req: Request, res: Response) => {
  try {
    const userId = (req.headers['x-user-id'] as string) || 'default-user';

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
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    const userId = (req.headers['x-user-id'] as string) || 'default-user';

    await getNotificationService().markAllAsRead(userId);

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to mark all as read', { error: String(error) });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to mark all as read' } });
  }
});

export { router as notificationRoutes };
