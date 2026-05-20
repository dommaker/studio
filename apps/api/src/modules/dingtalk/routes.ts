/**
 * 钉钉机器人交互回调
 *
 * 处理钉钉 ActionCard 按钮点击
 * 文档：https://open.dingtalk.com/document/orgapp/types-of-messages-supported-by-group-robots
 */

import express, { Router, Request, Response } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '../../utils/logger.js';
import { eventStore } from '../../core/event-store.js';

const router = express.Router();
const redis = eventStore;

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
    data: { meetingId, confirmedBy: 'dingtalk_button', timestamp: new Date().toISOString() },
  }));

  logger.info('Meeting confirmed, event published', { meetingId });
}

/**
 * GET /api/v1/dingtalk/action
 * 处理 ActionCard 按钮点击（钉钉通过 URL 跳转方式）
 */
router.get('/action', async (req: Request, res: Response): Promise<void> => {
  const action = req.query.action as string;

  logger.info('[DINGTALK] Button clicked', { action });

  if (!action || typeof action !== 'string') {
    res.send('<html><body><h1>⚠️ 无效操作</h1></body></html>');
    return;
  }

  const [actionType, meetingId] = action.split(':');

  try {
    if (actionType === 'confirm') {
      await proceedWithBranchCreation(meetingId);
      res.send(`
        <html>
          <head><title>已确认</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: green;">✅ 会议已确认执行</h1>
            <p>会议 ID: ${meetingId.slice(0, 8)}</p>
          </body>
        </html>
      `);
      return;
    }

    if (actionType === 'reject') {
      await prisma.meeting.update({
        where: { id: meetingId },
        data: { discussionStatus: 'rejected', status: 'completed' },
      });
      res.send(`
        <html>
          <head><title>已拒绝</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: red;">❌ 会议已拒绝执行</h1>
            <p>会议 ID: ${meetingId.slice(0, 8)}</p>
          </body>
        </html>
      `);
      return;
    }

    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: orange;">⚠️ 未知操作: ${actionType}</h1>
        </body>
      </html>
    `);
  } catch (error) {
    logger.error({ error: String(error) }, '[DINGTALK] Button handler error');
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ 处理失败</h1>
          <p>${String(error)}</p>
        </body>
      </html>
    `);
  }
});

/**
 * GET /api/v1/dingtalk/health
 */
router.get('/health', (_req: Request, res: Response): void => {
  res.json({ status: 'ok', service: 'dingtalk-callback' });
});

export default router;