/**
 * Notify API 路由
 * 
 * 端点：
 * - POST /api/v1/notify/send - 发送通知（供内部模块调用）
 * - GET  /api/v1/notify/config/status - 用户通知渠道配置状态（Settings 页同步指示）
 * - POST /api/v1/notify/config - 保存用户通知渠道配置（进程内存，重启丢失）
 */

import { Router, Request, Response } from 'express';
import { notifyService, NotifyMessage } from './notify.service.js';
import { logger } from '@dommaker/studio-shared';

const router = Router();

// ==================== 用户通知渠道配置（进程内存） ====================

interface ChannelUserConfig {
  enabled?: boolean;
  webhookUrl?: string;
  botToken?: string;
  chatId?: string;
}

interface NotifyUserConfig {
  discord?: ChannelUserConfig;
  wecom?: ChannelUserConfig;
  telegram?: ChannelUserConfig;
}

// 仅存进程内存：服务重启后丢失，前端 Settings 页会提示"通知配置需要重新保存"
let userConfig: NotifyUserConfig = {};

function hasUserConfig(c?: ChannelUserConfig): boolean {
  return !!(c && (c.webhookUrl || (c.botToken && c.chatId)));
}

/**
 * GET /api/v1/notify/config/status
 * 各渠道是否已有用户配置（前端用于"已同步/需重存"提示）
 */
router.get('/config/status', (_req: Request, res: Response) => {
  res.json({
    discord: { hasUserConfig: hasUserConfig(userConfig.discord) },
    wecom: { hasUserConfig: hasUserConfig(userConfig.wecom) },
    telegram: { hasUserConfig: hasUserConfig(userConfig.telegram) },
  });
});

/**
 * POST /api/v1/notify/config
 * 保存用户通知渠道配置到进程内存
 */
router.post('/config', (req: Request, res: Response) => {
  try {
    const { discord, wecom, telegram } = req.body ?? {};
    userConfig = { discord, wecom, telegram };
    logger.info('[Notify] User channel config updated', {
      discord: hasUserConfig(discord),
      wecom: hasUserConfig(wecom),
      telegram: hasUserConfig(telegram),
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('[Notify] Failed to save user config', { error: String(error) });
    res.status(500).json({ error: 'Failed to save notify config' });
  }
});

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