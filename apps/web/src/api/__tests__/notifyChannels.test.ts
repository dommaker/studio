// notifyChannelsApi — #525 P2-6：通知渠道配置（企微 webhook / ClawBot 扫码绑定），端点契约测试
import { describe, it, expect, vi } from 'vitest';

const { mockGet, mockPut, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
}));
vi.mock('../index', () => ({ api: { get: mockGet, put: mockPut, post: mockPost } }));

import { notifyChannelsApi } from '../notifyChannels';

describe('notifyChannelsApi（通知渠道配置）', () => {
  it('getStatus → GET /notify-channels（两渠道状态）', () => {
    notifyChannelsApi.getStatus();
    expect(mockGet).toHaveBeenCalledWith('/notify-channels');
  });

  it('saveWecom → PUT /notify-channels/wecom（body 携带 webhookUrl；空串清除）', () => {
    notifyChannelsApi.saveWecom('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k');
    expect(mockPut).toHaveBeenCalledWith('/notify-channels/wecom', {
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
    });
    notifyChannelsApi.saveWecom('');
    expect(mockPut).toHaveBeenCalledWith('/notify-channels/wecom', { webhookUrl: '' });
  });

  it('testWecom → POST /notify-channels/wecom/test', () => {
    notifyChannelsApi.testWecom();
    expect(mockPost).toHaveBeenCalledWith('/notify-channels/wecom/test');
  });

  it('startClawbotBind → POST /notify-channels/clawbot/bind/start', () => {
    notifyChannelsApi.startClawbotBind();
    expect(mockPost).toHaveBeenCalledWith('/notify-channels/clawbot/bind/start');
  });

  it('getClawbotBindStatus → GET /notify-channels/clawbot/bind/status（qrcode 走 query params）', () => {
    notifyChannelsApi.getClawbotBindStatus('qr-123');
    expect(mockGet).toHaveBeenCalledWith('/notify-channels/clawbot/bind/status', {
      params: { qrcode: 'qr-123' },
    });
  });

  it('unbindClawbot → POST /notify-channels/clawbot/unbind', () => {
    notifyChannelsApi.unbindClawbot();
    expect(mockPost).toHaveBeenCalledWith('/notify-channels/clawbot/unbind');
  });

  it('testClawbot → POST /notify-channels/clawbot/test', () => {
    notifyChannelsApi.testClawbot();
    expect(mockPost).toHaveBeenCalledWith('/notify-channels/clawbot/test');
  });
});
