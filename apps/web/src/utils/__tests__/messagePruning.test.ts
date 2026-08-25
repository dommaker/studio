// #326 频道消息数据层降级（ADR 2026-08-25 channel-message-data-pruning）：
// degradeMessage 骨架形状 + planPrune 阈值/迟滞/K 保底/水合触发纯函数测试。
import { describe, it, expect } from 'vitest';
import type { ChannelMessage } from '../../api/channel';
import { degradeMessage, planPrune } from '../messagePruning';

let seq = 0;
function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    channelId: 'c1',
    authorType: 'agent',
    content: `正文 ${seq}`,
    createdAt: new Date(1000 * seq).toISOString(),
    ...overrides,
  };
}

const OPTS = { keepRecent: 3, degradeDistance: 2, hydrateDistance: 1 };

describe('degradeMessage', () => {
  it('剥离 content/meta 大头，保留结构字段与 degraded 标记', () => {
    const full = msg({
      agentName: 'Analyst',
      replyToId: 'm0',
      workUnitId: 'wu-1',
      meta: { cardData: { heavy: 'x'.repeat(1000) }, options: [{ label: 'a' }] },
    });
    const s = degradeMessage(full);
    expect(s.degraded).toBe(true);
    expect(s.content).toBe('');
    expect(s.meta).toBeUndefined();
    // 结构字段全留
    expect(s.id).toBe(full.id);
    expect(s.createdAt).toBe(full.createdAt);
    expect(s.authorType).toBe('agent');
    expect(s.agentName).toBe('Analyst');
    expect(s.replyToId).toBe('m0');
    expect(s.workUnitId).toBe('wu-1');
  });

  it('保留 meta 的 status/cardType 标量子集（isCompleted/mergeable 判定不失真）', () => {
    const s = degradeMessage(msg({ meta: { status: 'done', cardType: 'wu_card', cardData: { big: 1 } } }));
    expect(s.meta).toEqual({ status: 'done', cardType: 'wu_card' });
  });

  it('对已是骨架的消息幂等', () => {
    const s = degradeMessage(msg());
    expect(degradeMessage(s)).toBe(s);
  });
});

describe('planPrune', () => {
  it('降级视口上方超过 degradeDistance 的消息', () => {
    const list = Array.from({ length: 10 }, () => msg());
    // anchor 在 index 7：degrade 边界 = 7-2=5 → [0,5) 降级
    const plan = planPrune(list, list[7].id, OPTS);
    expect(plan.degradeIds).toEqual(list.slice(0, 5).map(m => m.id));
  });

  it('keepRecent 保底：尾部 K 条永不降级', () => {
    const list = Array.from({ length: 6 }, () => msg());
    // anchor 在 index 5（最末）：边界 = min(5-2, 6-3)=3 → [0,3) 降级
    const plan = planPrune(list, list[5].id, OPTS);
    expect(plan.degradeIds).toEqual(list.slice(0, 3).map(m => m.id));
  });

  it('已是骨架的消息不重复降级', () => {
    const list = Array.from({ length: 10 }, () => msg());
    const withSkeleton = list.map((m, i) => (i < 5 ? degradeMessage(m) : m));
    const plan = planPrune(withSkeleton, list[7].id, OPTS);
    expect(plan.degradeIds).toEqual([]);
  });

  it('视口进入降级区（距边界 < hydrateDistance）→ 给出水合游标 = 首个非骨架消息 id', () => {
    const list = Array.from({ length: 10 }, () => msg());
    const withSkeleton = list.map((m, i) => (i < 5 ? degradeMessage(m) : m));
    // 边界 X=5；anchor 在 index 5（5 < 5+1）→ 水合
    const plan = planPrune(withSkeleton, list[5].id, OPTS);
    expect(plan.hydrateBefore).toBe(list[5].id);
  });

  it('视口远离降级区 → 不水合', () => {
    const list = Array.from({ length: 10 }, () => msg());
    const withSkeleton = list.map((m, i) => (i < 5 ? degradeMessage(m) : m));
    // anchor 在 index 8（8 >= 5+1）→ 不水合
    const plan = planPrune(withSkeleton, list[8].id, OPTS);
    expect(plan.hydrateBefore).toBeUndefined();
  });

  it('anchorMid 为 null 或不在数组中 → 空计划', () => {
    const list = Array.from({ length: 10 }, () => msg());
    expect(planPrune(list, null, OPTS)).toEqual({ degradeIds: [] });
    expect(planPrune(list, 'missing', OPTS)).toEqual({ degradeIds: [] });
  });
});
