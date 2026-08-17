// resolveChannelResponders — #177 频道可响应成员解析（与 AgentLoop.observe 同一口径）：
// channel.members 非空 → 仅成员；为空 → 回退 profile.channels（空 = 全频道可见）
import { describe, it, expect } from 'vitest';

import { resolveChannelResponders } from '../channelResponders';
import type { AgentProfile, Channel } from '../../../api/channel';

const AGENTS: AgentProfile[] = [
  { id: 'p1', name: 'dev', description: null, status: 'active' },
  { id: 'p2', name: 'ops', description: null, status: 'active' },
  { id: 'p3', name: 'outsider', description: null, status: 'active', channels: '["ch-9"]' },
];

describe('resolveChannelResponders', () => {
  it('channel.members 非空 → 仅成员（非成员即使 channels 含本频道也不入选）', () => {
    const ch = { id: 'ch-1', name: '#dev', type: 'rnd', members: '["p1","p2"]' } as Channel;
    const out = resolveChannelResponders(ch, 'ch-1', AGENTS);
    expect(out.map(a => a.id)).toEqual(['p1', 'p2']);
  });

  it('members 为空 → 回退 profile.channels：空 = 全频道可见；含本频道可见；其他频道不可见', () => {
    const ch = { id: 'ch-1', name: '#dev', type: 'rnd', members: '[]' } as Channel;
    const out = resolveChannelResponders(ch, 'ch-1', AGENTS);
    // p1/p2 无 channels 字段（= 空，全频道可见）；p3 只订 ch-9 → 排除
    expect(out.map(a => a.id)).toEqual(['p1', 'p2']);
  });

  it('频道不存在（undefined）→ 按 members 空处理，走 profile.channels 回退', () => {
    const out = resolveChannelResponders(undefined, 'ch-1', AGENTS);
    expect(out.map(a => a.id)).toEqual(['p1', 'p2']);
  });
});
