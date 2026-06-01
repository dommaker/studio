/**
 * 飞书机器人交互回调
 *
 * 处理飞书消息卡片按钮点击
 * 文档：https://open.feishu.cn/document/ukTMukTMukTM/uYjNwUjN2UjN2YjN-events-and-callbacks
 */

import express, { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
const router = express.Router();

/**
 * 验证飞书签名
 */
function verifyLarkSignature(body: string, signature: string, timestamp: string, secret: string): boolean {
  try {
    const crypto = require('crypto');
    const message = timestamp + '\n' + body;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(message);
    const expectedSignature = hmac.digest('base64');
    return signature === expectedSignature;
  } catch (error) {
    logger.error({ error: String(error) }, 'Lark signature verification error');
    return false;
  }
}

/**
 * POST /api/v1/lark/callback
 * 飞书机器人事件回调
 */
router.post('/callback', async (req: Request, res: Response): Promise<void> => {
  logger.info('[LARK] Callback received');

  const body = req.body;

  // URL 验证（飞书首次配置时发送）
  if (body.type === 'url_verification') {
    logger.info('[LARK] URL verification challenge');
    res.json({ challenge: body.challenge });
    return;
  }

  // 处理按钮点击事件
  if (body.header?.event_type === 'card.action.trigger') {
    const event = body.event;
    const action = event?.action?.value?.action || event?.action?.value;

    logger.info({ action, event }, '[LARK] Button clicked');

    if (!action || typeof action !== 'string') {
      logger.warn('[LARK] Invalid action value');
      res.json({ code: 0, msg: 'success' });
      return;
    }

    logger.info({ action }, '[LARK] Meeting action ignored (meeting module removed)');
    res.json({ code: 0, msg: 'success' });
    return;
  }

  // 其他事件类型
  logger.info({ eventType: body.header?.event_type }, '[LARK] Unhandled event type');
  res.json({ code: 0, msg: 'success' });
});

/**
 * GET /api/v1/lark/health
 */
router.get('/health', (_req: Request, res: Response): void => {
  res.json({ status: 'ok', service: 'lark-callback' });
});

export default router;