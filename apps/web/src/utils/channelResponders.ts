// 频道可响应成员解析（与 AgentLoop.observe 同一口径）——#177 PublishProjectDialog /
// AnalysisApproveDialog 共用：channel.members 唯一事实源（空 = 无成员；#696 起
// profile.channels 过渡口径已随存量验收退役）。下拉候选 = 频道成员（#69 决议，
// 与 @mention §9.5 语义一致：防「指名频道外成员 → 频道内无人可见」死角）。
import type { AgentProfile, Channel } from '../api/channel';
import { parseIdArray } from './okrMetric';

export function resolveChannelResponders(
  channel: Channel | undefined,
  activeAgents: AgentProfile[],
): AgentProfile[] {
  const memberIds = parseIdArray(channel?.members);
  return activeAgents.filter(p => memberIds.includes(p.id));
}
