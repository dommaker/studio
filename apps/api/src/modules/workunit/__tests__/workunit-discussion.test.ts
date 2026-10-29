import { describe, expect, it, vi } from 'vitest';
import {
  listDiscussionMessages,
  postDiscussionMessage,
  patchDiscussionMessage,
} from '../workunit-discussion.js';
import { validWorkUnit } from './route-fixtures.js';

const message = {
  id: 'msg-1', channelId: 'ch-1', workUnitId: 'wu-1', authorType: 'human', agentName: null,
  content: 'hello', replyToId: null, meta: {}, createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('WorkUnit discussion application（ARCH-06）', () => {
  it('list 复用 WU channelId 直查并保留分页派生', async () => {
    const listByWorkUnitId = vi.fn().mockResolvedValue({ data: [message], total: 2 });
    const result = await listDiscussionMessages('wu-1', { limit: 1 }, {
      service: { getById: vi.fn().mockResolvedValue(validWorkUnit({ channelId: 'ch-1' })) } as any,
      fileStore: {} as any,
      message: { listByWorkUnitId } as any,
    });

    expect(listByWorkUnitId).toHaveBeenCalledWith(expect.objectContaining({ workUnitId: 'wu-1', channelId: 'ch-1', limit: 1 }));
    expect(result).toEqual({ messages: [message], total: 2, hasMore: true });
  });

  it('post 无 WU 频道时回退首个 rnd 频道，无可用频道报 NO_CHANNEL', async () => {
    const createHumanMessage = vi.fn().mockResolvedValue(message);
    const fileStore = { listChannels: vi.fn().mockResolvedValue([{ id: 'ch-system' }]) };
    await postDiscussionMessage('wu-1', { content: 'hello' }, {
      service: { getById: vi.fn().mockResolvedValue(validWorkUnit({ channelId: null })) } as any,
      fileStore: fileStore as any,
      message: { createHumanMessage } as any,
    });
    expect(createHumanMessage).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'ch-system', workUnitId: 'wu-1' }));

    fileStore.listChannels.mockResolvedValue([]);
    await expect(postDiscussionMessage('wu-1', { content: 'hello' }, {
      service: { getById: vi.fn().mockResolvedValue(validWorkUnit({ channelId: null })) } as any,
      fileStore: fileStore as any,
      message: { createHumanMessage } as any,
    })).rejects.toMatchObject({ code: 'NO_CHANNEL' });
  });

  it('patch 校验消息归属后才调用 message port 更新', async () => {
    const updateMessage = vi.fn().mockResolvedValue(message);
    const fileStore = { getMessageById: vi.fn().mockResolvedValue({ channelId: 'ch-1', message: { ...message, workUnitId: 'other' } }) };
    await expect(patchDiscussionMessage('wu-1', 'msg-1', { content: 'changed' }, {
      service: { getById: vi.fn().mockResolvedValue(validWorkUnit({ channelId: 'ch-1' })) } as any,
      fileStore: fileStore as any,
      message: { updateMessage } as any,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'Message does not belong to this WorkUnit' });
    expect(updateMessage).not.toHaveBeenCalled();
  });
});
