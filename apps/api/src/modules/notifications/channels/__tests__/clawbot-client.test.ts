/**
 * #525 P2-6：ClawBot（iLink 协议）客户端测试
 *
 * vi.stubGlobal('fetch') 覆盖三端点：
 * - getBotQrcode：GET /ilink/bot/get_bot_qrcode?bot_type=3 → { qrcode, qrcodeUrl }
 * - getQrcodeStatus：GET /ilink/bot/get_qrcode_status?qrcode=<key>，
 *   Header iLink-App-ClientVersion: 1；wait/scaned/confirmed，confirmed 带凭据
 * - sendText：POST /ilink/bot/sendmessage，头/体包装断言 + errcode 透传（-14 会话过期）
 * - 非 2xx / 网络异常 → 抛错
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getBotQrcode, getQrcodeStatus, sendText } from '../clawbot-client.js';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('clawbot-client (#525 P2-6)', () => {
  describe('getBotQrcode', () => {
    it('成功：返回 qrcode 与 qrcodeUrl（= qrcode_img_content）', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        qrcode: 'qr-key-1',
        qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/abc',
      }));

      const result = await getBotQrcode();

      expect(result).toEqual({ qrcode: 'qr-key-1', qrcodeUrl: 'https://ilinkai.weixin.qq.com/qr/abc' });
      const [url, init] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
      expect(init.method ?? 'GET').toBe('GET');
    });

    it('上游非 2xx → 抛错（含状态码）', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}, 503));
      await expect(getBotQrcode()).rejects.toThrow(/503/);
    });

    it('网络异常 → 抛错透传', async () => {
      mockFetch.mockRejectedValue(new Error('connect timeout'));
      await expect(getBotQrcode()).rejects.toThrow('connect timeout');
    });
  });

  describe('getQrcodeStatus', () => {
    it('请求带 iLink-App-ClientVersion: 1 头与 qrcode query', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 'wait' }));

      await getQrcodeStatus('qr-key-1');

      const [url, init] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('/ilink/bot/get_qrcode_status?qrcode=qr-key-1');
      expect(init.headers['iLink-App-ClientVersion']).toBe('1');
    });

    it.each(['wait', 'scaned'] as const)('状态 %s 原样返回，不带凭据', async (status) => {
      mockFetch.mockResolvedValue(jsonResponse({ status }));
      const result = await getQrcodeStatus('qr-key-1');
      expect(result.status).toBe(status);
      expect(result.credentials).toBeUndefined();
    });

    it('confirmed → 返回凭据四件套（bot_token/ilink_bot_id/ilink_user_id/baseurl）', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        status: 'confirmed',
        bot_token: 'tok-1',
        ilink_bot_id: 'bot-9',
        ilink_user_id: 'user-9',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }));

      const result = await getQrcodeStatus('qr-key-1');

      expect(result.status).toBe('confirmed');
      expect(result.credentials).toEqual({
        botToken: 'tok-1',
        ilinkBotId: 'bot-9',
        ilinkUserId: 'user-9',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      });
    });

    it('上游非 2xx → 抛错', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}, 500));
      await expect(getQrcodeStatus('qr-key-1')).rejects.toThrow(/500/);
    });
  });

  describe('sendText', () => {
    const base = {
      botToken: 'tok-secret',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      toUserId: 'user-9',
      text: 'hello clawbot',
    };

    it('请求头：Authorization Bearer / AuthorizationType / X-WECHAT-UIN', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));

      await sendText(base);

      const [url, init] = mockFetch.mock.calls[0];
      expect(String(url)).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer tok-secret');
      expect(init.headers.AuthorizationType).toBe('ilink_bot_token');
      expect(typeof init.headers['X-WECHAT-UIN']).toBe('string');
      expect(init.headers['X-WECHAT-UIN'].length).toBeGreaterThan(0);
    });

    it('请求体：msg 包装（to_user_id / message_type 2 / message_state 2 / text_item）+ base_info', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));

      await sendText(base);

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.msg.from_user_id).toBe('');
      expect(body.msg.to_user_id).toBe('user-9');
      expect(body.msg.message_type).toBe(2);
      expect(body.msg.message_state).toBe(2);
      expect(typeof body.msg.client_id).toBe('string');
      expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: 'hello clawbot' } }]);
      expect(body.base_info).toEqual({ channel_version: '1.0.2' });
    });

    it('空对象 {} 响应 = 成功', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      await expect(sendText(base)).resolves.toBeUndefined();
    });

    it('errcode=-14（会话过期）→ 抛错且错误信息透传 errcode', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ errcode: -14, errmsg: 'session expired' }));
      await expect(sendText(base)).rejects.toThrow(/-14/);
    });

    it('其他 errcode → 抛错透传', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ errcode: 40001, errmsg: 'bad request' }));
      await expect(sendText(base)).rejects.toThrow(/40001/);
    });

    it('上游非 2xx → 抛错（含状态码）', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}, 502));
      await expect(sendText(base)).rejects.toThrow(/502/);
    });
  });
});
