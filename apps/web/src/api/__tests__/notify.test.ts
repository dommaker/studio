// notifyApi — 用户通知渠道配置：端点契约测试
import { describe, it, expect, vi } from 'vitest';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock('../index', () => ({ api: { get: mockGet, post: mockPost } }));

import { notifyApi } from '../notify';

describe('notifyApi（通知渠道配置）', () => {
  it('getConfigStatus → GET /notify/config/status（「已同步/需重存」指示）', () => {
    notifyApi.getConfigStatus();
    expect(mockGet).toHaveBeenCalledWith('/notify/config/status');
  });

  it('saveConfig → POST /notify/config（进程内存，重启丢失）', () => {
    const config = {
      discord: { enabled: true, webhookUrl: 'https://discord.example/hook' },
      telegram: { enabled: false, botToken: '', chatId: '' },
    };
    notifyApi.saveConfig(config);
    expect(mockPost).toHaveBeenCalledWith('/notify/config', config);
  });
});
