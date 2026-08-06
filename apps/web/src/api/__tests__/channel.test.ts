// channelApi — 端点契约测试（Wave-4：useChannelList / ChannelDetailPage 原始调用收编）
import { describe, it, expect, vi } from 'vitest';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock('../index', () => ({ api: { get: mockGet, post: mockPost } }));

import { channelApi } from '../channel';

describe('channelApi', () => {
  it('list → GET /channels', () => {
    channelApi.list();
    expect(mockGet).toHaveBeenCalledWith('/channels');
  });

  it('get → GET /channels/:id', () => {
    channelApi.get('ch-1');
    expect(mockGet).toHaveBeenCalledWith('/channels/ch-1');
  });

  it('create → POST /channels（含可选初始 agents）', () => {
    channelApi.create({ name: 'general', type: 'chat', agents: [{ name: 'ceo' }] });
    expect(mockPost).toHaveBeenCalledWith('/channels', {
      name: 'general',
      type: 'chat',
      agents: [{ name: 'ceo' }],
    });
  });
});
