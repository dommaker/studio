// 频道可响应成员解析（与 AgentLoop.observe 同一口径）——#177 PublishProjectDialog /
// AnalysisApproveDialog 共用：channel.members 非空 → 仅成员；为空（历史频道未回填）
// → 回退 profile.channels（空 = 全频道可见）。下拉候选 = 频道成员（#69 决议，
// 与 @mention §9.5 语义一致：防「指名频道外成员 → 频道内无人可见」死角）。
import type { AgentProfile, Channel } from '../../api/channel';
import { parseIdArray } from './okrMetric';

export function resolveChannelResponders(
  channel: Channel | undefined,
  channelId: string,
  activeAgents: AgentProfile[],
): AgentProfile[] {
  const memberIds = parseIdArray(channel?.members);
  if (memberIds.length > 0) return activeAgents.filter(p => memberIds.includes(p.id));
  return activeAgents.filter(p => {
    const chs = parseIdArray(typeof p.channels === 'string' ? p.channels : JSON.stringify(p.channels ?? []));
    return chs.length === 0 || chs.includes(channelId);
  });
}
