// joinDefaultChannel 单测（#465）：首用引导「一键加入 #研发」——解析频道、加成员、写穿 store。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockList, mockUpdateMembers } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockUpdateMembers: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    list: mockList,
    updateMembers: mockUpdateMembers,
  },
}));

import { joinDefaultChannel } from '../joinChannel';
import { useChannelDataStore } from '../../../stores/channelDataStore';

describe('joinDefaultChannel（#465 一键加入 #研发）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChannelDataStore.getState().__resetForTests();
    mockUpdateMembers.mockResolvedValue({ data: { success: true, data: { members: ['agent-1'] } } });
  });

  it('命中 #研发 → updateMembers 加成员 + 写穿 channelDataStore + 返回频道 id', async () => {
    mockList.mockResolvedValue({
      data: { success: true, data: [
        { id: 'ch-sys', name: '#系统', type: 'system' },
        { id: 'ch-rnd', name: '#研发', type: 'rnd' },
      ] },
    });

    const id = await joinDefaultChannel('agent-1');

    expect(id).toBe('ch-rnd');
    expect(mockUpdateMembers).toHaveBeenCalledWith('ch-rnd', { add: ['agent-1'] });
    expect(useChannelDataStore.getState().members['ch-rnd']).toEqual(['agent-1']);
  });

  it('写穿与存量成员合并去重（不从响应覆盖，照 handleAdd 先例）', async () => {
    mockList.mockResolvedValue({ data: { success: true, data: [{ id: 'ch-rnd', name: '#研发', type: 'rnd' }] } });
    useChannelDataStore.getState().setMembers('ch-rnd', ['agent-0']);

    const id = await joinDefaultChannel('agent-1');

    expect(id).toBe('ch-rnd');
    expect(useChannelDataStore.getState().members['ch-rnd']).toEqual(['agent-0', 'agent-1']);
  });

  it('未找到 #研发 频道 → 返回 null，不调 updateMembers', async () => {
    mockList.mockResolvedValue({ data: { success: true, data: [{ id: 'ch-sys', name: '#系统', type: 'system' }] } });

    const id = await joinDefaultChannel('agent-1');

    expect(id).toBeNull();
    expect(mockUpdateMembers).not.toHaveBeenCalled();
  });

  it('list / updateMembers 失败 → 返回 null 不抛出（best-effort，引导步内联报错）', async () => {
    mockList.mockRejectedValue(new Error('network'));
    expect(await joinDefaultChannel('agent-1')).toBeNull();

    mockList.mockResolvedValue({ data: { success: true, data: [{ id: 'ch-rnd', name: '#研发', type: 'rnd' }] } });
    mockUpdateMembers.mockRejectedValue(new Error('409'));
    expect(await joinDefaultChannel('agent-1')).toBeNull();
  });
});
