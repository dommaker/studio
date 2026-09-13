/**
 * #525 P2-6：/api/v1/notify-channels 路由契约测试
 *
 * express 起测试服务（参照 channel-messages-pagination.test.ts 的 beforeAll 模式），
 * STUDIO_HOME 指向临时目录隔离配置存储；上游（企微 webhook / iLink）fetch 全部 stub。
 *
 * 冻结契约（前端并行开发，不得偏离）：
 *   GET  /                        → { wecom: { configured, maskedUrl, source }, clawbot: { bound, ilinkUserId, boundAt } }
 *   PUT  /wecom                   → 空串清除；非 https://qyapi.weixin.qq.com/ 开头 400
 *   POST /wecom/test              → 配置存储优先 env 兜底；未配置 400；上游失败 502
 *   POST /clawbot/bind/start      → { qrcode, qrcodeUrl }；上游失败 502
 *   GET  /clawbot/bind/status     → wait/scaned/confirmed；confirmed 持久化后 bound:true
 *   POST /clawbot/unbind          → 清除
 *   POST /clawbot/test            → 未绑定 400；失败 502 带 errcode 透传
 * 脱敏：任何响应不得出现完整 webhookUrl / botToken。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';

const WECOM_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secretkey123456';
const BOT_TOKEN = 'clawbot-token-secret-abcdef';

const mockFetch = vi.fn();

/** 测试服自身的 HTTP 调用用原生 fetch（stubGlobal 后全局 fetch 被换成 mockFetch，仅上游调用走 mock） */
const realFetch = globalThis.fetch;

let tmpDir: string;
let server: Server;
let baseUrl: string;
let envBackup: Record<string, string | undefined>;

const ENV_KEYS = ['STUDIO_HOME', 'WECOM_WEBHOOK_URL'] as const;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-channels-routes-'));
  envBackup = {};
  for (const k of ENV_KEYS) envBackup[k] = process.env[k];
  process.env.STUDIO_HOME = tmpDir;
  delete process.env.WECOM_WEBHOOK_URL;

  const { default: notifyChannelRoutes } = await import('../routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/notify-channels', notifyChannelRoutes);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1/notify-channels`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  delete process.env.WECOM_WEBHOOK_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 清配置存储，保证用例间隔离 */
async function resetConfig() {
  await realFetch(`${baseUrl}/wecom`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookUrl: '' }),
  });
  await realFetch(`${baseUrl}/clawbot/unbind`, { method: 'POST' });
}

describe('GET / 初始未配置', () => {
  it('返回双段未配置形态', async () => {
    await resetConfig();
    const res = await realFetch(baseUrl);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        wecom: { configured: false, maskedUrl: null, source: null },
        clawbot: { bound: false, ilinkUserId: null, boundAt: null },
      },
    });
  });
});

describe('PUT /wecom', () => {
  it('合法 webhook 保存成功，GET 回读 configured + source=settings，URL 已脱敏', async () => {
    const res = await realFetch(`${baseUrl}/wecom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: WECOM_URL }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.configured).toBe(true);
    expect(body.data.source).toBe('settings');
    expect(body.data.maskedUrl).not.toBe(WECOM_URL);
    expect(JSON.stringify(body)).not.toContain(WECOM_URL);

    const getBody = await (await realFetch(baseUrl)).json();
    expect(getBody.data.wecom.configured).toBe(true);
    expect(getBody.data.wecom.source).toBe('settings');
    expect(JSON.stringify(getBody)).not.toContain(WECOM_URL);
  });

  it('非 https://qyapi.weixin.qq.com/ 开头 → 400', async () => {
    const res = await realFetch(`${baseUrl}/wecom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://evil.example.com/hook' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('webhookUrl 非字符串 → 400', async () => {
    const res = await realFetch(`${baseUrl}/wecom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it('空串清除 → GET 回读未配置', async () => {
    await realFetch(`${baseUrl}/wecom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: WECOM_URL }),
    });
    const res = await realFetch(`${baseUrl}/wecom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: '' }),
    });
    expect(res.status).toBe(200);
    const getBody = await (await realFetch(baseUrl)).json();
    expect(getBody.data.wecom).toEqual({ configured: false, maskedUrl: null, source: null });
  });
});

describe('POST /wecom/test', () => {
  it('未配置 → 400', async () => {
    await resetConfig();
    const res = await realFetch(`${baseUrl}/wecom/test`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('配置存储 URL 优先于 env：两个都设时打到配置存储的 URL', async () => {
    process.env.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=envkey9999';
    await realFetch(`${baseUrl}/wecom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: WECOM_URL }),
    });
    mockFetch.mockResolvedValue(jsonResponse({ errcode: 0 }));

    const res = await realFetch(`${baseUrl}/wecom/test`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(WECOM_URL);
    const payload = JSON.parse(init.body);
    expect(payload.msgtype).toBe('markdown');
  });

  it('仅 env 配置时经 env 发送，GET 显示 source=env', async () => {
    await resetConfig();
    process.env.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=envkey9999';
    mockFetch.mockResolvedValue(jsonResponse({ errcode: 0 }));

    const res = await realFetch(`${baseUrl}/wecom/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe(process.env.WECOM_WEBHOOK_URL);

    const getBody = await (await realFetch(baseUrl)).json();
    expect(getBody.data.wecom).toEqual({
      configured: true,
      maskedUrl: expect.any(String),
      source: 'env',
    });
    expect(JSON.stringify(getBody)).not.toContain(process.env.WECOM_WEBHOOK_URL);
  });

  it('上游非 2xx → 502 { success: false, error }', async () => {
    await resetConfig();
    process.env.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=envkey9999';
    mockFetch.mockResolvedValue(jsonResponse({}, 500));

    const res = await realFetch(`${baseUrl}/wecom/test`, { method: 'POST' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('fetch 异常 → 502', async () => {
    await resetConfig();
    process.env.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=envkey9999';
    mockFetch.mockRejectedValue(new Error('network unreachable'));

    const res = await realFetch(`${baseUrl}/wecom/test`, { method: 'POST' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('network unreachable');
  });
});

describe('ClawBot 绑定流程', () => {
  it('POST /clawbot/bind/start → { qrcode, qrcodeUrl }', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      qrcode: 'qr-key-1',
      qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/abc',
    }));

    const res = await realFetch(`${baseUrl}/clawbot/bind/start`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { qrcode: 'qr-key-1', qrcodeUrl: 'https://ilinkai.weixin.qq.com/qr/abc' },
    });
  });

  it('bind/start 上游失败 → 502', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 503));
    const res = await realFetch(`${baseUrl}/clawbot/bind/start`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect((await res.json()).success).toBe(false);
  });

  it('GET /clawbot/bind/status 缺 qrcode 参数 → 400', async () => {
    const res = await realFetch(`${baseUrl}/clawbot/bind/status`);
    expect(res.status).toBe(400);
  });

  it('status=wait → bound:false', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'wait' }));
    const res = await realFetch(`${baseUrl}/clawbot/bind/status?qrcode=qr-key-1`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { status: 'wait', bound: false } });
  });

  it('status=confirmed → 凭据持久化，返回 bound:true；GET / 显示已绑定且脱敏', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      status: 'confirmed',
      bot_token: BOT_TOKEN,
      ilink_bot_id: 'bot-9',
      ilink_user_id: 'ilink-user-987654321',
      baseurl: 'https://ilinkai.weixin.qq.com',
    }));

    const res = await realFetch(`${baseUrl}/clawbot/bind/status?qrcode=qr-key-1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { status: 'confirmed', bound: true } });
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);

    const getRes = await realFetch(baseUrl);
    const getBody = await getRes.json();
    expect(getBody.data.clawbot.bound).toBe(true);
    expect(getBody.data.clawbot.ilinkUserId).not.toBe('ilink-user-987654321');
    expect(getBody.data.clawbot.boundAt).toEqual(expect.any(String));
    expect(JSON.stringify(getBody)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(getBody)).not.toContain('ilink-user-987654321');
  });

  it('bind/status 上游失败 → 502', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500));
    const res = await realFetch(`${baseUrl}/clawbot/bind/status?qrcode=qr-key-1`);
    expect(res.status).toBe(502);
  });
});

describe('POST /clawbot/test 与 unbind', () => {
  async function bindClawBot() {
    mockFetch.mockResolvedValue(jsonResponse({
      status: 'confirmed',
      bot_token: BOT_TOKEN,
      ilink_bot_id: 'bot-9',
      ilink_user_id: 'ilink-user-987654321',
      baseurl: 'https://ilinkai.weixin.qq.com',
    }));
    await realFetch(`${baseUrl}/clawbot/bind/status?qrcode=qr-key-1`);
    mockFetch.mockClear();
  }

  it('未绑定 → 400', async () => {
    await resetConfig();
    const res = await realFetch(`${baseUrl}/clawbot/test`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
  });

  it('已绑定 → sendText 到 ilinkUserId，成功 { success: true }，token 不出现在响应', async () => {
    await resetConfig();
    await bindClawBot();
    mockFetch.mockResolvedValue(jsonResponse({}));

    const res = await realFetch(`${baseUrl}/clawbot/test`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/ilink/bot/sendmessage');
    expect(init.headers.Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    const payload = JSON.parse(init.body);
    expect(payload.msg.to_user_id).toBe('ilink-user-987654321');
  });

  it('发送失败（errcode=-14 会话过期）→ 502，error 透传 errcode', async () => {
    await resetConfig();
    await bindClawBot();
    mockFetch.mockResolvedValue(jsonResponse({ errcode: -14, errmsg: 'session expired' }));

    const res = await realFetch(`${baseUrl}/clawbot/test`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.error).toContain('-14');
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);
  });

  it('unbind → 清除绑定，GET / 回到未绑定', async () => {
    await resetConfig();
    await bindClawBot();

    const res = await realFetch(`${baseUrl}/clawbot/unbind`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const getBody = await (await realFetch(baseUrl)).json();
    expect(getBody.data.clawbot).toEqual({ bound: false, ilinkUserId: null, boundAt: null });
  });
});
