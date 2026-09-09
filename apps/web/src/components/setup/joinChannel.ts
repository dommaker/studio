// #465（首用路径断点）：一键加入 #研发——解析默认频道（按名字，同 cli/dev.ts 先例）、
// 加成员（channel.members 是成员关系唯一事实源）、写穿 channelDataStore（照
// ChannelMemberManager.handleAdd 先例：以调用完成时刻 store 最新值为基合并，不用响应覆盖）。
// best-effort：任何一步失败返回 null 不抛出，由引导步内联报错。
import { channelApi } from '../../api/channel';
import { useChannelDataStore } from '../../stores/channelDataStore';

const DEFAULT_CHANNEL_NAME = '#研发';

/** 把角色加入 #研发 频道；成功返回频道 id，失败/频道不存在返回 null */
export async function joinDefaultChannel(agentId: string): Promise<string | null> {
  try {
    const res = await channelApi.list();
    const channel = res.data.data.find((c) => c.name === DEFAULT_CHANNEL_NAME);
    if (!channel) return null;
    await channelApi.updateMembers(channel.id, { add: [agentId] });
    const cur = useChannelDataStore.getState().members[channel.id] ?? [];
    useChannelDataStore.getState().setMembers(channel.id, [...new Set([...cur, agentId])]);
    return channel.id;
  } catch {
    return null;
  }
}
