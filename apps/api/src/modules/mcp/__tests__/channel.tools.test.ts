/**
 * channel.tools 单元测试（P2，#566）。
 *
 * 覆盖 getChannelMessages：包装 fileStore.readMessagesTail（热层尾部，新→旧），
 * limit 钳制 [1,100] 默认 20。tool-store 的 fileStore 被 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadMessagesTail } = vi.hoisted(() => ({
  mockReadMessagesTail: vi.fn(),
}));

vi.mock('../tool-store.js', () => ({
  fileStore: { readMessagesTail: mockReadMessagesTail },
}));

import { channelTools } from '../channel.tools.js';

const getChannelMessages = channelTools[0];

describe('channel.tools', () => {
  beforeEach(() => vi.clearAllMocks());

  it('仅导出 getChannelMessages，exposure=external，required=[channelId]', () => {
    expect(channelTools.map(t => t.name)).toEqual(['getChannelMessages']);
    expect(getChannelMessages.exposure).toBe('external');
    expect(getChannelMessages.inputSchema.required).toEqual(['channelId']);
  });

  it('透传 channelId 与 limit，返回 { messages, total }', async () => {
    const messages = [{ id: 'm2' }, { id: 'm1' }];
    mockReadMessagesTail.mockResolvedValue({ messages, exhausted: false });
    const result = await getChannelMessages.handler({ channelId: 'ch-1', limit: 5 });
    expect(mockReadMessagesTail).toHaveBeenCalledWith('ch-1', { limit: 5 });
    expect(result).toEqual({ messages, total: 2 });
  });

  it('limit 缺省 20，越界钳制到 [1, 100]', async () => {
    mockReadMessagesTail.mockResolvedValue({ messages: [], exhausted: true });
    await getChannelMessages.handler({ channelId: 'ch-1' });
    expect(mockReadMessagesTail).toHaveBeenCalledWith('ch-1', { limit: 20 });
    await getChannelMessages.handler({ channelId: 'ch-1', limit: 9999 });
    expect(mockReadMessagesTail).toHaveBeenCalledWith('ch-1', { limit: 100 });
    await getChannelMessages.handler({ channelId: 'ch-1', limit: 0 });
    expect(mockReadMessagesTail).toHaveBeenCalledWith('ch-1', { limit: 20 });
  });

  it('频道不存在（ENOENT → 空页）返回空数组不抛错', async () => {
    mockReadMessagesTail.mockResolvedValue({ messages: [], exhausted: true });
    expect(await getChannelMessages.handler({ channelId: 'ch-ghost' }))
      .toEqual({ messages: [], total: 0 });
  });
});
