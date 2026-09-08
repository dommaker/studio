/**
 * Notify API 路由
 *
 * 端点：
 * - POST /api/v1/notify/send - 发送通知（供内部模块调用）
 *
 * #434：用户通知渠道配置端点（POST /config、GET /config/status）已随设置页死配置清理删除——
 * 配置落盘后无任何发送方消费（真实通路走 env/外部配置），notify-config.json 不再读写。
 */

import { Router, Request, Response } from 'express';
import { notifyService, NotifyMessage } from './notify.service.js';
import { logger } from '@dommaker/studio-shared';

const router = Router();

// ==================== 发送通知 ====================
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { type, taskId, meetingId, title, content, priority } = req.body;

    if (!type || !title || !content) {
      return res.status(400).json({ error: 'Missing required fields: type, title, content' });
    }

    await notifyService.send({
      type,
      taskId,
      meetingId,
      title,
      content,
      priority: priority || 'medium',
    } as NotifyMessage);

    res.json({ success: true, message: 'Notification sent' });
  } catch (error) {
    logger.error('Error sending notification', { error: String(error) });
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

export default router;
