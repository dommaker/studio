// resolveChannelResponders — #177 频道可响应成员解析（与 AgentLoop.observe 同一口径）：
// channel.members 唯一事实源（空 = 无成员；#696 起不再回退 profile.channels）
import { describe, it, expect } from 'vitest';

import { resolveChannelResponders } from '../channelResponders';
import type { AgentProfile, Channel } from '../../api/channel';

const AGENTS: AgentProfile[] = [
  { id: 'p1', name: 'dev', description: null, status: 'active' },
  { id: 'p2', name: 'ops', description: null, status: 'active' },
  { id: 'p3', name: 'outsider', description: null, status: 'active', channels: '["ch-1"]' },
];

describe('resolveChannelResponders', () => {
  it('channel.members 非空 → 仅成员（非成员即使 channels 含本频道也不入选）', () => {
    const ch = { id: 'ch-1', name: '#dev', type: 'rnd', members: '["p1","p2"]' } as Channel;
    const out = resolveChannelResponders(ch, AGENTS);
    expect(out.map(a => a.id)).toEqual(['p1', 'p2']);
  });

  it('members 为空 → 无响应者（严格口径：即使 profile.channels 含本频道也不入选）', () => {
    const ch = { id: 'ch-1', name: '#dev', type: 'rnd', members: '[]' } as Channel;
    // p3 的 profile.channels 含 ch-1 —— #696 起该过渡口径已退役，不再计入
    const out = resolveChannelResponders(ch, AGENTS);
    expect(out).toEqual([]);
  });

  it('频道不存在（undefined）→ 无成员 = 无响应者', () => {
    const out = resolveChannelResponders(undefined, AGENTS);
    expect(out).toEqual([]);
  });
});
