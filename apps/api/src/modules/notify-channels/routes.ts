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
 *
 * 契约驱动迁移（2026-10 批次 5/7）：走 core/http.ts defineRoute——webhookUrl/qrcode
 * 必填收进 zod；`{ success, data }` 壳的 success 标志退役（响应统一 `{ data }`，
 * 原裸 `{ success: true }` → `{ data: { success } }`）；错误统一
 * `{ error: { code, message } }`（原 `{ success: false, error: string }` 退役；
 * 400 未配置/未绑定与前缀校验文案保留，502 上游失败 code = BAD_GATEWAY、文案保留
 * 实际错误消息含 errcode 透传）。
 */
import { Router } from 'express';
import {
  loadNotifyChannelsConfig,
  saveNotifyChannelsConfig,
  resolveWeComWebhookUrl,
} from './config-store.js';
import { getBotQrcode, getQrcodeStatus, sendText } from './clawbot-client.js';
import { postWeComMarkdown } from './wecom-client.js';
import { getErrorMessage } from '../../utils/errors.js';
import { defineRoute, HttpError } from '../../core/http.js';
import {
  ERROR_CODES,
  putWecomBodySchema,
  clawbotBindStatusQuerySchema,
} from '@dommaker/studio-contract';

const WECOM_URL_PREFIX = 'https://qyapi.weixin.qq.com/';
/** 上游（企微 webhook / iLink）失败 → 502（errcode 透传在 message 里，如 -14 = 会话过期需重扫） */
const BAD_GATEWAY = 'BAD_GATEWAY';

/** 上游调用兜底：非 HttpError（网络/超时/上游错误）一律转 502，文案保留实际错误消息 */
async function withUpstream<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, BAD_GATEWAY, getErrorMessage(error));
  }
}

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
router.get('/', defineRoute({}, async () => ({
  wecom: wecomSegment(),
  clawbot: clawbotSegment(),
})));

/** PUT /wecom — 保存 webhook（空串清除）；非企微前缀 400 */
router.put('/wecom', defineRoute(
  { body: putWecomBodySchema },
  async (_req, _res, { body }) => {
    const trimmed = body.webhookUrl.trim();
    if (trimmed && !trimmed.startsWith(WECOM_URL_PREFIX)) {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, `webhookUrl must start with ${WECOM_URL_PREFIX}`);
    }
    const config = loadNotifyChannelsConfig();
    config.wecom = trimmed ? { webhookUrl: trimmed } : null;
    saveNotifyChannelsConfig(config);
    return wecomSegment();
  },
));

/** POST /wecom/test — 经同一解析（配置存储优先、env 兜底）发一条测试 markdown */
router.post('/wecom/test', defineRoute({}, async () => {
  const { url } = resolveWeComWebhookUrl();
  if (!url) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'WeCom webhook not configured');
  }
  return withUpstream(async () => {
    const { ok, status } = await postWeComMarkdown(
      url,
      '[INFO] **Studio 通知渠道测试**\n企业微信 webhook 配置生效。',
    );
    if (!ok) {
      throw new HttpError(502, BAD_GATEWAY, `WeCom webhook returned HTTP ${status}`);
    }
    return { success: true };
  });
}));

/** POST /clawbot/bind/start — 取扫码二维码（qrcodeUrl = qrcode_img_content） */
router.post('/clawbot/bind/start', defineRoute({}, async () => withUpstream(() => getBotQrcode())));

/** GET /clawbot/bind/status?qrcode= — 轮询；confirmed 时凭据持久化后返回 bound:true */
router.get('/clawbot/bind/status', defineRoute(
  { query: clawbotBindStatusQuerySchema },
  async (_req, _res, { query }) => withUpstream(async () => {
    const { status, credentials } = await getQrcodeStatus(query.qrcode);
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
    return { status, bound: status === 'confirmed' };
  }),
));

/** POST /clawbot/unbind — 清除 ClawBot 绑定 */
router.post('/clawbot/unbind', defineRoute({}, async () => {
  const config = loadNotifyChannelsConfig();
  config.clawbot = null;
  saveNotifyChannelsConfig(config);
  return { success: true };
}));

/** POST /clawbot/test — 向已绑定用户发测试文本（失败 502，errcode 透传，如 -14 = 会话过期需重扫） */
router.post('/clawbot/test', defineRoute({}, async () => {
  const clawbot = loadNotifyChannelsConfig().clawbot;
  if (!clawbot?.botToken) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'ClawBot not bound');
  }
  return withUpstream(async () => {
    await sendText({
      botToken: clawbot.botToken,
      baseUrl: clawbot.baseUrl,
      toUserId: clawbot.ilinkUserId,
      text: '[INFO] Studio 通知渠道测试：ClawBot 绑定生效。',
    });
    return { success: true };
  });
}));

export default router;
