/**
 * notifier (P0 修复 4) — 统一告警出口 fan-out 测试
 *
 * 覆盖：
 * - 频道 sink：STUDIO_ALERT_CHANNEL_ID 优先 → 按名字找「系统」/system → 都没有跳过 + warn
 * - 企业微信 sink：WECOM_WEBHOOK_URL 存在时 POST markdown；未配置跳过
 * - fan-out 降级：任一 sink 失败不影响另一个，notifyAlert 不抛错
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockLogger, mockListChannels, mockAppendMessage, mockFetch } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockListChannels: vi.fn(),
  mockAppendMessage: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: mockLogger,
  FileStore: vi.fn().mockImplementation(function () {
    return { listChannels: mockListChannels, appendMessage: mockAppendMessage };
  }),
}));

import { notifyAlert } from '../notifier.js';

const ENV_KEYS = ['STUDIO_ALERT_CHANNEL_ID', 'WECOM_WEBHOOK_URL'] as const;

describe('notifier (P0 修复 4)', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockAppendMessage.mockResolvedValue(undefined);
    mockListChannels.mockResolvedValue([]);
    mockFetch.mockResolvedValue({ ok: true });
    for (const k of ENV_KEYS) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  });

  describe('频道 sink', () => {
    it('STUDIO_ALERT_CHANNEL_ID 优先，发 agent:Studio 系统消息，不查频道列表', async () => {
      process.env.STUDIO_ALERT_CHANNEL_ID = 'ch-alert-1';

      await notifyAlert('critical', 'Test title', 'Test body');

      expect(mockListChannels).not.toHaveBeenCalled();
      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
      const [channelId, msg] = mockAppendMessage.mock.calls[0];
      expect(channelId).toBe('ch-alert-1');
      expect(msg.authorType).toBe('agent');
      expect(msg.agentName).toBe('Studio');
      expect(msg.content).toContain('[CRITICAL]');
      expect(msg.content).toContain('Test title');
      expect(msg.content).toContain('Test body');
    });

    it.each(['#系统', '系统', 'system', '#system'])('无 env 时按名字 %s 回落', async (name) => {
      mockListChannels.mockResolvedValue([
        { id: 'ch-other', name: '#研发' },
        { id: 'ch-sys', name },
      ]);

      await notifyAlert('warning', 't', 'b');

      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
      expect(mockAppendMessage.mock.calls[0][0]).toBe('ch-sys');
      expect(mockAppendMessage.mock.calls[0][1].content).toContain('[WARNING]');
    });

    it('env 与候选频道都没有 → 跳过并 logger.warn，不抛错', async () => {
      mockListChannels.mockResolvedValue([{ id: 'ch-x', name: '#研发' }]);

      await expect(notifyAlert('warning', 't', 'b')).resolves.toBeUndefined();

      expect(mockAppendMessage).not.toHaveBeenCalled();
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
      await notifyAlert('info', 't', 'b');
      expect(mockFetch).not.toHaveBeenCalled();
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
      mockAppendMessage.mockRejectedValue(new Error('disk full'));

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

      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
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
});
