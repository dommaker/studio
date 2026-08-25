/**
 * 飞书机器人交互回调
 *
 * 处理飞书消息卡片按钮点击
 * 文档：https://open.feishu.cn/document/ukTMukTMukTM/uYjNwUjN2UjN2YjN-events-and-callbacks
 */

import express, { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { logger } from '../../utils/logger.js';
const router = express.Router();

/**
 * 飞书回调验签 — 2026-08-25 接线
 *
 * 此前 verifyLarkSignature（HMAC 方案，与飞书实际签名方案不符）写了但从未调用，
 * 属摆设；现按飞书事件订阅的 verification token 机制校验（v1 body.token /
 * v2 header.token），timingSafeEqual 防时序侧信道。
 * LARK_VERIFICATION_TOKEN 未配置时 fail-closed 503（对齐 deploy webhook：
 * 验签材料缺失宁可拒服也不裸奔，防止"先上线后配 token"的窗口期被伪造回调）。
 */
const VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN || '';

function verifyLarkToken(body: any): boolean {
  if (!VERIFICATION_TOKEN) return false;
  const token = body?.token ?? body?.header?.token ?? '';
  if (typeof token !== 'string' || token.length !== VERIFICATION_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(VERIFICATION_TOKEN));
}

/**
 * POST /api/v1/lark/callback
 * 飞书机器人事件回调
 */
router.post('/callback', async (req: Request, res: Response): Promise<void> => {
  logger.info('[LARK] Callback received');

  if (!VERIFICATION_TOKEN) {
    logger.error('[LARK] LARK_VERIFICATION_TOKEN not configured — refusing callback');
    res.status(503).json({ error: 'Lark callback not configured' });
    return;
  }

  const body = req.body;

  if (!verifyLarkToken(body)) {
    logger.warn('[LARK] Invalid verification token');
    res.status(401).json({ error: 'Invalid verification token' });
    return;
  }

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