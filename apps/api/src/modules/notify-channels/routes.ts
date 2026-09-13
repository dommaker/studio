/**
 * #525 P2-6：/api/v1/notify-channels —— /settings「通知渠道」配置区读写 API
 *
 * 这是 #434 删掉的死配置的「复活成真功能」版：配了必须真生效——
 * 消费方是 utils/notifier.ts 的 notifyAlert 告警/催办外推（#523 tier2）。
 *
 * 冻结契约（前端并行开发，不得偏离）：
 *   GET  /                     → 双段状态（企微脱敏 URL + source；ClawBot 绑定态脱敏）
 *   PUT  /wecom                → 保存/清除 webhook（空串清除；非 qyapi 前缀 400）
 *   POST /wecom/test           → 经「配置存储优先、env 兜底」发一条测试 markdown
 *   POST /clawbot/bind/start   → 取扫码二维码
 *   GET  /clawbot/bind/status  → 轮询扫码状态；confirmed 持久化凭据
 *   POST /clawbot/unbind       → 清除 ClawBot 绑定
 *   POST /clawbot/test         → 向已绑定用户发一条测试文本
 *
 * 脱敏：任何响应不得出现完整 webhookUrl / botToken / ilinkUserId（走 maskValue）。
 * 写操作敏感，整模块挂 admin（route-registry 注册处）。
 */
import { Router, type Request, type Response } from 'express';
import {
  loadNotifyChannelsConfig,
  saveNotifyChannelsConfig,
  resolveWeComWebhookUrl,
} from './config-store.js';
import { getBotQrcode, getQrcodeStatus, sendText } from './clawbot-client.js';
import { getErrorMessage } from '../../utils/errors.js';

const WECOM_URL_PREFIX = 'https://qyapi.weixin.qq.com/';
const WECOM_TEST_TIMEOUT_MS = 5_000;

/** 与 CLI config.ts 同款脱敏（不跨域 import CLI）：length<=8 → '****'，否则 first4...last4 */
function maskValue(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** GET / 与 PUT /wecom 共用的企微段（脱敏；source 区分配置存储/仅 env） */
function wecomSegment() {
  const { url, source } = resolveWeComWebhookUrl();
  return {
    configured: url !== null,
    maskedUrl: url ? maskValue(url) : null,
    source,
  };
}

function clawbotSegment() {
  const clawbot = loadNotifyChannelsConfig().clawbot;
  return {
    bound: Boolean(clawbot?.botToken),
    ilinkUserId: clawbot?.ilinkUserId ? maskValue(clawbot.ilinkUserId) : null,
    boundAt: clawbot?.boundAt ?? null,
  };
}

const router = Router();

/** GET / — 双段状态总览 */
router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, data: { wecom: wecomSegment(), clawbot: clawbotSegment() } });
});

/** PUT /wecom — 保存 webhook（空串清除）；非企微前缀 400 */
router.put('/wecom', (req: Request, res: Response) => {
  const webhookUrl = (req.body as { webhookUrl?: unknown })?.webhookUrl;
  if (typeof webhookUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'webhookUrl must be a string' });
  }
  const trimmed = webhookUrl.trim();
  if (trimmed && !trimmed.startsWith(WECOM_URL_PREFIX)) {
    return res.status(400).json({ success: false, error: `webhookUrl must start with ${WECOM_URL_PREFIX}` });
  }
  const config = loadNotifyChannelsConfig();
  config.wecom = trimmed ? { webhookUrl: trimmed } : null;
  saveNotifyChannelsConfig(config);
  res.json({ success: true, data: wecomSegment() });
});

/** POST /wecom/test — 经同一解析（配置存储优先、env 兜底）发一条测试 markdown */
router.post('/wecom/test', async (_req: Request, res: Response) => {
  const { url } = resolveWeComWebhookUrl();
  if (!url) {
    return res.status(400).json({ success: false, error: 'WeCom webhook not configured' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WECOM_TEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: '[INFO] **Studio 通知渠道测试**\n企业微信 webhook 配置生效。' },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return res.status(502).json({ success: false, error: `WeCom webhook returned HTTP ${response.status}` });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(502).json({ success: false, error: getErrorMessage(error) });
  } finally {
    clearTimeout(timer);
  }
});

/** POST /clawbot/bind/start — 取扫码二维码（qrcodeUrl = qrcode_img_content） */
router.post('/clawbot/bind/start', async (_req: Request, res: Response) => {
  try {
    const data = await getBotQrcode();
    res.json({ success: true, data });
  } catch (error) {
    res.status(502).json({ success: false, error: getErrorMessage(error) });
  }
});

/** GET /clawbot/bind/status?qrcode= — 轮询；confirmed 时凭据持久化后返回 bound:true */
router.get('/clawbot/bind/status', async (req: Request, res: Response) => {
  const qrcode = req.query.qrcode;
  if (typeof qrcode !== 'string' || !qrcode) {
    return res.status(400).json({ success: false, error: 'qrcode query param is required' });
  }
  try {
    const { status, credentials } = await getQrcodeStatus(qrcode);
    if (status === 'confirmed' && credentials) {
      const config = loadNotifyChannelsConfig();
      config.clawbot = {
        botToken: credentials.botToken,
        baseUrl: credentials.baseUrl,
        ilinkBotId: credentials.ilinkBotId,
        ilinkUserId: credentials.ilinkUserId,
        boundAt: new Date().toISOString(),
      };
      saveNotifyChannelsConfig(config);
    }
    res.json({ success: true, data: { status, bound: status === 'confirmed' } });
  } catch (error) {
    res.status(502).json({ success: false, error: getErrorMessage(error) });
  }
});

/** POST /clawbot/unbind — 清除 ClawBot 绑定 */
router.post('/clawbot/unbind', (_req: Request, res: Response) => {
  const config = loadNotifyChannelsConfig();
  config.clawbot = null;
  saveNotifyChannelsConfig(config);
  res.json({ success: true });
});

/** POST /clawbot/test — 向已绑定用户发测试文本（失败 502，errcode 透传，如 -14 = 会话过期需重扫） */
router.post('/clawbot/test', async (_req: Request, res: Response) => {
  const clawbot = loadNotifyChannelsConfig().clawbot;
  if (!clawbot?.botToken) {
    return res.status(400).json({ success: false, error: 'ClawBot not bound' });
  }
  try {
    await sendText({
      botToken: clawbot.botToken,
      baseUrl: clawbot.baseUrl,
      toUserId: clawbot.ilinkUserId,
      text: '[INFO] Studio 通知渠道测试：ClawBot 绑定生效。',
    });
    res.json({ success: true });
  } catch (error) {
    res.status(502).json({ success: false, error: getErrorMessage(error) });
  }
});

export default router;
