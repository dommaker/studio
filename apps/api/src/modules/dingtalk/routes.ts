/**
 * 钉钉机器人交互回调
 *
 * 处理钉钉 ActionCard 按钮点击
 * 文档：https://open.dingtalk.com/document/orgapp/types-of-messages-supported-by-group-robots
 */

import express, { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
const router = express.Router();

/**
 * GET /api/v1/dingtalk/action
 * 处理 ActionCard 按钮点击（钉钉通过 URL 跳转方式）
 */
router.get('/action', async (req: Request, res: Response): Promise<void> => {
  const action = req.query.action as string;

  logger.info({ action }, '[DINGTALK] Button clicked');

  if (!action || typeof action !== 'string') {
    res.send('<html><body><h1>⚠️ 无效操作</h1></body></html>');
    return;
  }

  logger.info({ action }, '[DINGTALK] Meeting action ignored (meeting module removed)');
  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>操作已忽略（Meeting 模块已移除）</h1>
      </body>
    </html>
  `);
});

/**
 * GET /api/v1/dingtalk/health
 */
router.get('/health', (_req: Request, res: Response): void => {
  res.json({ status: 'ok', service: 'dingtalk-callback' });
});

export default router;