/**
 * #525 P2-6：ClawBot（iLink 协议）客户端 —— 扫码绑定 + 文本发送
 *
 * 接入域 https://ilinkai.weixin.qq.com，纯 HTTP/JSON，无需 OpenClaw 网关。
 * 三个端点：
 *   取码  GET /ilink/bot/get_bot_qrcode?bot_type=3 → { qrcode, qrcode_img_content }
 *   轮询  GET /ilink/bot/get_qrcode_status?qrcode=<key>（Header iLink-App-ClientVersion: 1）
 *         状态 wait → scaned → confirmed；confirmed 返回 bot_token / ilink_bot_id /
 *         ilink_user_id / baseurl。bot_token 长期有效，是后续调用的 Bearer 凭据。
 *   发送  POST /ilink/bot/sendmessage（Bearer bot_token + AuthorizationType + X-WECHAT-UIN），
 *         空对象 {} 响应 = 成功。
 *
 * 能力约束（协议实测，2026-03）：
 *   - 主动推送受限：用户最后一条消息后 24h 内最多 10 条（context_token 留空可发）；
 *   - 仅文本；
 *   - token 可能过期：errcode=-14 = 会话过期，需重新扫码绑定——发送失败时 errcode 透传到错误信息。
 */
import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const REQUEST_TIMEOUT_MS = 10_000;

export interface ClawBotQrcode {
  /** 轮询 key */
  qrcode: string;
  /** 供扫码的 URL（= 上游 qrcode_img_content） */
  qrcodeUrl: string;
}

export interface ClawBotCredentials {
  botToken: string;
  ilinkBotId: string;
  ilinkUserId: string;
  baseUrl: string;
}

export type ClawBotBindStatus = 'wait' | 'scaned' | 'confirmed';

export interface ClawBotQrcodeStatus {
  status: ClawBotBindStatus;
  /** 仅 confirmed 时存在 */
  credentials?: ClawBotCredentials;
}

type FetchImpl = typeof fetch;

/** 带超时的 fetch 包装（AbortController，10s） */
async function fetchWithTimeout(url: string, init: RequestInit, fetchImpl: FetchImpl): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 取绑定二维码 */
export async function getBotQrcode(fetchImpl: FetchImpl = fetch): Promise<ClawBotQrcode> {
  const response = await fetchWithTimeout(
    `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
    { method: 'GET' },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`[ClawBot] get_bot_qrcode failed: HTTP ${response.status}`);
  }
  const body = await readJson(response);
  if (typeof body.qrcode !== 'string' || typeof body.qrcode_img_content !== 'string') {
    throw new Error('[ClawBot] get_bot_qrcode: unexpected response shape');
  }
  return { qrcode: body.qrcode, qrcodeUrl: body.qrcode_img_content };
}

/** 轮询扫码状态；confirmed 时带出凭据四件套 */
export async function getQrcodeStatus(qrcode: string, fetchImpl: FetchImpl = fetch): Promise<ClawBotQrcodeStatus> {
  const response = await fetchWithTimeout(
    `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    { method: 'GET', headers: { 'iLink-App-ClientVersion': '1' } },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`[ClawBot] get_qrcode_status failed: HTTP ${response.status}`);
  }
  const body = await readJson(response);
  const status = body.status;
  if (status !== 'wait' && status !== 'scaned' && status !== 'confirmed') {
    throw new Error(`[ClawBot] get_qrcode_status: unexpected status ${String(status)}`);
  }
  if (status !== 'confirmed') return { status };
  return {
    status,
    credentials: {
      botToken: String(body.bot_token ?? ''),
      ilinkBotId: String(body.ilink_bot_id ?? ''),
      ilinkUserId: String(body.ilink_user_id ?? ''),
      baseUrl: String(body.baseurl ?? '') || DEFAULT_BASE_URL,
    },
  };
}

export interface SendTextOptions {
  botToken: string;
  /** confirmed 凭据里的 baseurl，缺省接入域 */
  baseUrl?: string;
  toUserId: string;
  text: string;
}

/** X-WECHAT-UIN：随机 uint32 的 base64 */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64');
}

/**
 * 发送文本消息（context_token 省略——主动推送受 24h/10 条限制，见模块头注释）。
 * 空对象 {} 响应 = 成功；body 带 errcode（如 -14 会话过期）→ 抛错并透传 errcode。
 */
export async function sendText(opts: SendTextOptions, fetchImpl: FetchImpl = fetch): Promise<void> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${baseUrl}/ilink/bot/sendmessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.botToken}`,
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin(),
      },
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: opts.toUserId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: opts.text } }],
        },
        base_info: { channel_version: '1.0.2' },
      }),
    },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`[ClawBot] sendmessage failed: HTTP ${response.status}`);
  }
  const body = await readJson(response);
  if (typeof body.errcode === 'number' && body.errcode !== 0) {
    // errcode=-14 = 会话过期，需重新扫码绑定（错误信息透传 errcode 供上层提示）
    throw new Error(`[ClawBot] sendmessage errcode=${body.errcode}${body.errmsg ? `: ${String(body.errmsg)}` : ''}`);
  }
}
