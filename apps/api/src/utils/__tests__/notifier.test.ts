/**
 * notifier (P0 修复 4) — 统一告警出口 fan-out 测试
 *
 * 覆盖：
 * - 频道 sink：STUDIO_ALERT_CHANNEL_ID 优先 → 按名字找「系统」/system → 都没有跳过 + warn
 * - 企业微信 sink：WECOM_WEBHOOK_URL 存在时 POST markdown；未配置跳过；
 *   #525 P2-6 起 URL 解析「配置存储优先、env 兜底」
 * - ClawBot sink（#525 P2-6）：配置存储已绑定时 sendText 到 ilinkUserId；未绑定跳过
 * - fan-out 降级：任一 sink 失败不影响另一个，notifyAlert 不抛错
 *
 * 配置存储走真实 config-store + 临时 STUDIO_HOME（mkdtemp），不 mock，
 * 以覆盖「配置存储优先于 env」的真实文件链路。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { mockLogger, mockListChannels, mockCreateAgentMessage, mockFetch, mockCreateForAllUsers } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockListChannels: vi.fn(),
  mockCreateAgentMessage: vi.fn(),
  mockFetch: vi.fn(),
  mockCreateForAllUsers: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: mockLogger,
  FileStore: vi.fn().mockImplementation(function () {
    return { listChannels: mockListChannels };
  }),
}));

// 频道 sink 经 ChannelMessageService（eventBus + SSE 发布），此处只验证委托
vi.mock('../../modules/channels/channel-message.service.js', () => ({
  ChannelMessageService: vi.fn().mockImplementation(function () {
    return { createAgentMessage: mockCreateAgentMessage };
  }),
}));

// #468 行动中心 sink 经 NotificationService.createForAllUsers 持久化，此处只验证委托
vi.mock('@dommaker/studio-notification', () => ({
  NotificationService: vi.fn().mockImplementation(function () {
    return { createForAllUsers: mockCreateForAllUsers };
  }),
}));

import { notifyAlert } from '../notifier.js';
import { saveNotifyChannelsConfig } from '../../modules/notify-channels/config-store.js';

const ENV_KEYS = ['STUDIO_ALERT_CHANNEL_ID', 'WECOM_WEBHOOK_URL', 'STUDIO_HOME'] as const;

describe('notifier (P0 修复 4)', () => {
  const envBackup: Record<string, string | undefined> = {};
  let tmpStudioHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockCreateAgentMessage.mockResolvedValue(undefined);
    mockListChannels.mockResolvedValue([]);
    mockFetch.mockResolvedValue({ ok: true });
    mockCreateForAllUsers.mockResolvedValue(1);
    for (const k of ENV_KEYS) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
    // #525 P2-6：配置存储隔离到临时 STUDIO_HOME（默认空配置）
    tmpStudioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-cfg-'));
    process.env.STUDIO_HOME = tmpStudioHome;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    fs.rmSync(tmpStudioHome, { recursive: true, force: true });
  });

  describe('频道 sink', () => {
    it('STUDIO_ALERT_CHANNEL_ID 优先，发 agent:Studio 系统消息，不查频道列表', async () => {
      process.env.STUDIO_ALERT_CHANNEL_ID = 'ch-alert-1';

      await notifyAlert('critical', 'Test title', 'Test body');

      expect(mockListChannels).not.toHaveBeenCalled();
      expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1);
      const [channelId, agentName, content] = mockCreateAgentMessage.mock.calls[0];
      expect(channelId).toBe('ch-alert-1');
      expect(agentName).toBe('Studio');
      expect(content).toContain('[CRITICAL]');
      expect(content).toContain('Test title');
      expect(content).toContain('Test body');
      // warning/critical 带 atHuman（通知铃响）
      expect(mockCreateAgentMessage.mock.calls[0][3]).toEqual({ meta: { atHuman: true } });
    });

    it.each(['#系统', '系统', 'system', '#system'])('无 env 时按名字 %s 回落', async (name) => {
      mockListChannels.mockResolvedValue([
        { id: 'ch-other', name: '#研发' },
        { id: 'ch-sys', name },
      ]);

      await notifyAlert('warning', 't', 'b');

      expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateAgentMessage.mock.calls[0][0]).toBe('ch-sys');
      expect(mockCreateAgentMessage.mock.calls[0][2]).toContain('[WARNING]');
    });

    it('env 与候选频道都没有 → 跳过并 logger.warn，不抛错', async () => {
      mockListChannels.mockResolvedValue([{ id: 'ch-x', name: '#研发' }]);

      await expect(notifyAlert('warning', 't', 'b')).resolves.toBeUndefined();

      expect(mockCreateAgentMessage).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No alert channel found'),
      );
    });
  });

  describe('企业微信 sink', () => {
    it('WECOM_WEBHOOK_URL 存在时 POST markdown 群机器人消息', async () => {
      process.env.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc';

      await notifyAlert('critical', 'T', 'B');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(process.env.WECOM_WEBHOOK_URL);
      expect(init.method).toBe('POST');
      const payload = JSON.parse(init.body);
      expect(payload.msgtype).toBe('markdown');
      expect(payload.markdown.content).toContain('[CRITICAL]');
      expect(payload.markdown.content).toContain('T');
      expect(payload.markdown.content).toContain('B');
    });

    it('未配置 WECOM_WEBHOOK_URL → 跳过，不调用 fetch', async () => {
      process.env.STUDIO_ALERT_CHANNEL_ID = 'ch-alert-1';
      await notifyAlert('info', 't', 'b');
      expect(mockFetch).not.toHaveBeenCalled();
      // info 级不带 atHuman（不响铃）
      expect(mockCreateAgentMessage.mock.calls[0][3]).toBeUndefined();
    });

    it('webhook 返回非 2xx → warn 但不抛错', async () => {
      process.env.WECOM_WEBHOOK_URL = 'https://example.com/hook';
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      await expect(notifyAlert('warning', 't', 'b')).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('non-OK'),
        expect.objectContaining({ status: 500 }),
      );
    });
  });

  describe('fan-out 降级', () => {
    it('频道 sink 失败不影响企业微信 sink，notifyAlert 不抛错', async () => {
      process.env.STUDIO_ALERT_CHANNEL_ID = 'ch-alert-1';
      process.env.WECOM_WEBHOOK_URL = 'https://example.com/hook';
      mockCreateAgentMessage.mockRejectedValue(new Error('disk full'));

      await expect(notifyAlert('critical', 't', 'b')).resolves.toBeUndefined();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Channel sink failed'),
        expect.objectContaining({ error: expect.stringContaining('disk full') }),
      );
    });

    it('企业微信 sink 失败不影响频道 sink，notifyAlert 不抛错', async () => {
      process.env.STUDIO_ALERT_CHANNEL_ID = 'ch-alert-1';
      process.env.WECOM_WEBHOOK_URL = 'https://example.com/hook';
      mockFetch.mockRejectedValue(new Error('network unreachable'));

      await expect(notifyAlert('critical', 't', 'b')).resolves.toBeUndefined();

      expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('WeCom sink failed'),
        expect.objectContaining({ error: expect.stringContaining('network unreachable') }),
      );
    });

    it('两个 sink 都失败也只是 warn，不向调用方抛错', async () => {
      process.env.WECOM_WEBHOOK_URL = 'https://example.com/hook';
      mockListChannels.mockRejectedValue(new Error('fs broken'));
      mockFetch.mockRejectedValue(new Error('timeout'));

      await expect(notifyAlert('warning', 't', 'b')).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('行动中心 sink（#468 持久化）', () => {
    it('warning/critical → createForAllUsers 落 monitor_alert 通知', async () => {
      await notifyAlert('critical', 'Test title', 'Test body');

      expect(mockCreateForAllUsers).toHaveBeenCalledTimes(1);
      expect(mockCreateForAllUsers).toHaveBeenCalledWith(expect.objectContaining({
        type: 'monitor_alert',
        title: 'Test title',
        content: 'Test body',
      }));
    });

    it('opts.wuId → 通知带 wuId 与 WU 详情直链', async () => {
      await notifyAlert('warning', 'T', 'B', { wuId: 'wu-1' });

      expect(mockCreateForAllUsers).toHaveBeenCalledWith(expect.objectContaining({
        wuId: 'wu-1',
        link: '/workunits/wu-1',
      }));
    });

    it('info 级不持久化（与 atHuman 口径一致，防刷屏）', async () => {
      await notifyAlert('info', 'T', 'B');

      expect(mockCreateForAllUsers).not.toHaveBeenCalled();
    });

    it('通知 sink 失败不影响其他 sink，notifyAlert 不抛错', async () => {
      process.env.STUDIO_ALERT_CHANNEL_ID = 'ch-alert-1';
      mockCreateForAllUsers.mockRejectedValue(new Error('jsonl locked'));

      await expect(notifyAlert('critical', 't', 'b')).resolves.toBeUndefined();

      expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Notification sink failed'),
        expect.objectContaining({ error: expect.stringContaining('jsonl locked') }),
      );
    });
  });

  describe('企业微信 sink（#525 P2-6：配置存储优先、env 兜底）', () => {
    it('配置存储与 env 都设时打到配置存储的 URL', async () => {
      process.env.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=envkey';
      saveNotifyChannelsConfig({
        wecom: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=settingskey' },
      });

      await notifyAlert('critical', 'T', 'B');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=settingskey');
    });

    it('仅 env 时照旧走 env URL', async () => {
      process.env.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=envkey';

      await notifyAlert('critical', 'T', 'B');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe(process.env.WECOM_WEBHOOK_URL);
    });
  });

  describe('ClawBot sink（#525 P2-6）', () => {
    const CLAWBOT_CFG = {
      botToken: 'tok-clawbot',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      ilinkBotId: 'bot-1',
      ilinkUserId: 'ilink-user-1',
      boundAt: '2026-09-12T00:00:00.000Z',
    };

    function clawbotCalls() {
      return mockFetch.mock.calls.filter(([url]) => String(url).includes('/ilink/bot/sendmessage'));
    }

    it('已绑定时 sendText 到 ilinkUserId（文本与企微段同内容）', async () => {
      saveNotifyChannelsConfig({ clawbot: CLAWBOT_CFG });

      await notifyAlert('critical', 'Test title', 'Test body');

      const calls = clawbotCalls();
      expect(calls).toHaveLength(1);
      const [, init] = calls[0];
      expect(init.headers.Authorization).toBe('Bearer tok-clawbot');
      const payload = JSON.parse(init.body);
      expect(payload.msg.to_user_id).toBe('ilink-user-1');
      const text = payload.msg.item_list[0].text_item.text;
      expect(text).toContain('[CRITICAL]');
      expect(text).toContain('Test title');
      expect(text).toContain('Test body');
    });

    it('未绑定时不触发 ClawBot sink', async () => {
      await notifyAlert('warning', 't', 'b');
      expect(clawbotCalls()).toHaveLength(0);
    });

    it('发送失败不阻断其他 sink，仅 logger.warn', async () => {
      process.env.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=envkey';
      saveNotifyChannelsConfig({ clawbot: CLAWBOT_CFG });
      mockFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/ilink/bot/sendmessage')) throw new Error('ilink down');
        return { ok: true };
      });

      await expect(notifyAlert('critical', 't', 'b')).resolves.toBeUndefined();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('ClawBot sink failed'),
        expect.objectContaining({ error: expect.stringContaining('ilink down') }),
      );
      // 企微 sink 仍被调用
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes('key=envkey'))).toBe(true);
    });
  });
});
