/**
 * 飞书机器人交互回调
 *
 * 处理飞书消息卡片按钮点击
 * 文档：https://open.feishu.cn/document/ukTMukTMukTM/uYjNwUjN2UjN2YjN-events-and-callbacks
 */

import express, { Router, Request, Response } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '../../utils/logger.js';
import { eventStore } from '../../core/event-store.js';

const router = express.Router();
const redis = eventStore;

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
 * 继续执行会议流程
 */
async function proceedWithBranchCreation(meetingId: string): Promise<void> {
  logger.info('Proceeding with branch creation', { meetingId });

  await prisma.meeting.update({
    where: { id: meetingId },
    data: { discussionStatus: 'confirmed', status: 'completed' },
  });

  await redis.publish('events:meeting', JSON.stringify({
    event_type: 'meeting.confirmed',
    data: { meetingId, confirmedBy: 'lark_button', timestamp: new Date().toISOString() },
  }));

  logger.info('Meeting confirmed, event published', { meetingId });
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

    logger.info('[LARK] Button clicked', { action, event });

    if (!action || typeof action !== 'string') {
      logger.warn('[LARK] Invalid action value');
      res.json({ code: 0, msg: 'success' });
      return;
    }

    const [actionType, meetingId] = action.split(':');

    try {
      if (actionType === 'confirm') {
        await proceedWithBranchCreation(meetingId);
        // 更新卡片显示
        res.json({
          code: 0,
          msg: 'success',
          toast: {
            type: 'success',
            content: '✅ 会议已确认执行',
          },
        });
        return;
      }

      if (actionType === 'reject') {
        await prisma.meeting.update({
          where: { id: meetingId },
          data: { discussionStatus: 'rejected', status: 'completed' },
        });
        res.json({
          code: 0,
          msg: 'success',
          toast: {
            type: 'error',
            content: '❌ 会议已拒绝执行',
          },
        });
        return;
      }

      res.json({
        code: 0,
        msg: 'success',
        toast: {
          type: 'warning',
          content: `⚠️ 未知操作: ${actionType}`,
        },
      });
    } catch (error) {
      logger.error({ error: String(error) }, '[LARK] Button handler error');
      res.json({
        code: 0,
        msg: 'success',
        toast: {
          type: 'error',
          content: `❌ 处理失败`,
        },
      });
    }
    return;
  }

  // 其他事件类型
  logger.info('[LARK] Unhandled event type', { eventType: body.header?.event_type });
  res.json({ code: 0, msg: 'success' });
});

/**
 * GET /api/v1/lark/health
 */
router.get('/health', (_req: Request, res: Response): void => {
  res.json({ status: 'ok', service: 'lark-callback' });
});

export default router;