// #394 频道动态右栏纯函数：四站 stepper 推导 / 动态条目构建 / REQ 归属分流
import { describe, it, expect } from 'vitest';
import {
  deriveChainSteps,
  projectActivityMessages,
  buildChannelActivity,
  attributeActivity,
  deriveActivityRows,
  fmtRelTime,
  type ChannelActivityItem,
} from '../activityRail';
import type { Requirement, RequirementChainWorkUnit } from '../../../api/requirements';
import type { ChannelMessage } from '../../../api/channel';

function req(over: Partial<Requirement> = {}): Requirement {
  return {
    id: 'REQ-0001', seq: 1, title: '需求一', status: 'in-progress',
    createdAt: '2026-08-01T00:00:00Z', createdBy: 'human', ...over,
  };
}

function wu(id: string, status: string, over: Partial<RequirementChainWorkUnit> = {}): RequirementChainWorkUnit {
  return { id, title: `任务${id}`, status, assigneeId: null, ...over };
}

describe('deriveChainSteps — 四站 stepper', () => {
  it('REQ 终态（done/archived）→ 全线 done，WU 站带真实计数', () => {
    const steps = deriveChainSteps(req({ status: 'done' }), [wu('a', 'done'), wu('b', 'closed')]);
    expect(steps.map(s => [s.key, s.state, s.label])).toEqual([
      ['discuss', 'done', '讨论'],
      ['req', 'done', 'REQ'],
      ['wu', 'done', 'WU 2/2'],
      ['deliver', 'done', '交付'],
    ]);
  });

  it('无 WU → 讨论 done / REQ current / WU upcoming / 交付 upcoming', () => {
    const steps = deriveChainSteps(req({ status: 'open' }), []);
    expect(steps.map(s => [s.key, s.state, s.label])).toEqual([
      ['discuss', 'done', '讨论'],
      ['req', 'current', 'REQ'],
      ['wu', 'upcoming', 'WU 0/0'],
      ['deliver', 'upcoming', '交付'],
    ]);
    expect(steps.find(s => s.key === 'wu')?.wuId).toBeUndefined();
  });

  it('部分 WU 终态 → REQ done / WU current 带 n/m 计数 / 交付 upcoming；WU 站指向第一个非终态 WU', () => {
    const steps = deriveChainSteps(req(), [wu('a', 'done'), wu('b', 'active'), wu('c', 'unassigned')]);
    expect(steps.map(s => [s.key, s.state, s.label])).toEqual([
      ['discuss', 'done', '讨论'],
      ['req', 'done', 'REQ'],
      ['wu', 'current', 'WU 1/3'],
      ['deliver', 'upcoming', '交付'],
    ]);
    expect(steps.find(s => s.key === 'wu')?.wuId).toBe('b');
  });

  it('WU 全终态但 REQ 未终 → WU done / 交付 current；WU 站回落最后一个 WU', () => {
    const steps = deriveChainSteps(req(), [wu('a', 'done'), wu('b', 'closed')]);
    expect(steps.map(s => [s.key, s.state, s.label])).toEqual([
      ['discuss', 'done', '讨论'],
      ['req', 'done', 'REQ'],
      ['wu', 'done', 'WU 2/2'],
      ['deliver', 'current', '交付'],
    ]);
    expect(steps.find(s => s.key === 'wu')?.wuId).toBe('b');
  });

  it('archived 同样视为 REQ 终态', () => {
    const steps = deriveChainSteps(req({ status: 'archived' }), []);
    expect(steps.every(s => s.state === 'done')).toBe(true);
  });
});

function msg(id: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id, channelId: 'ch1', authorType: 'agent', content: '正文',
    createdAt: '2026-08-10T00:00:00Z', ...over,
  } as ChannelMessage;
}

describe('projectActivityMessages — #416 消息摘要投影（全量消息 → 右栏最小条目集）', () => {
  it('卡片消息（meta.cardType，string meta）→ card 条目，带 wuId', () => {
    const items = projectActivityMessages([
      msg('m1', { meta: JSON.stringify({ cardType: 'analysis_confirm' }), workUnitId: 'wu-1', content: '第一行\n第二行' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'm1', kind: 'card', wuId: 'wu-1' });
    expect(items[0].text).toContain('analysis_confirm');
    expect(items[0].text).not.toContain('第二行');
  });

  it('agent WU 消息 → wu 条目；人类消息与普通 agent 消息（无 WU）不进投影', () => {
    const items = projectActivityMessages([
      msg('m1', { workUnitId: 'wu-1' }),
      msg('m2', { authorType: 'human', workUnitId: 'wu-1' }),
      msg('m3'),
    ]);
    expect(items.map(i => i.id)).toEqual(['m1']);
    expect(items[0].kind).toBe('wu');
  });

  it('坏 meta（非 JSON）静默跳过 card 判定，不炸', () => {
    const items = projectActivityMessages([
      msg('m1', { meta: '{bad json', workUnitId: 'wu-1' }),
    ]);
    expect(items[0].kind).toBe('wu');
  });

  it('保序不排序：输出顺序 = 消息数组顺序（排序归 buildChannelActivity）', () => {
    const items = projectActivityMessages([
      msg('m1', { workUnitId: 'wu-1', createdAt: '2026-08-10T00:00:00Z' }),
      msg('m2', { workUnitId: 'wu-2', createdAt: '2026-08-09T00:00:00Z' }),
    ]);
    expect(items.map(i => i.id)).toEqual(['m1', 'm2']);
  });
});

describe('buildChannelActivity — 动态条目（#416 起消费消息摘要投影）', () => {
  const wuItem = (id: string, over: Partial<ChannelActivityItem> = {}): ChannelActivityItem => ({
    id, kind: 'wu', text: `动态${id}`, at: '2026-08-10T00:00:00Z', wuId: 'wu-1', ...over,
  });

  it('消息投影条目直挂；REQ 与 NEED_INPUT 待办进动态；整体按时间倒序', () => {
    const items = buildChannelActivity({
      messageItems: [wuItem('m1')],
      reqs: [req({ createdAt: '2026-08-01T00:00:00Z' })],
      waitingWus: [{ wuId: 'wu-9', question: '选哪个方案？' }],
    });
    expect(items.map(i => i.kind)).toEqual(['wu', 'wu', 'req']); // waiting(pinned 置顶) > m1 > req
    expect(items[0].text).toContain('选哪个方案？');
    expect(items[0].wuId).toBe('wu-9');
    // NEED_INPUT 待办无真实事件时刻：pinned 置顶排序，不伪造时间戳
    expect(items[0].pinned).toBe(true);
    expect(items[0].at).toBeUndefined();
    expect(items[2].reqId).toBe('REQ-0001');
  });

  it('空投影 + 空 REQ + 空待办 → 空集', () => {
    expect(buildChannelActivity({ messageItems: [], reqs: [], waitingWus: [] })).toEqual([]);
  });
});

describe('attributeActivity — REQ 归属分流', () => {
  const wuToReq = new Map([['wu-1', 'REQ-0001']]);

  it('reqId 直挂 > wuId 经映射 > 无归属落 other', () => {
    const items = [
      { id: 'a', kind: 'req' as const, text: '', at: '2026-08-10T00:00:00Z', reqId: 'REQ-0001' },
      { id: 'b', kind: 'wu' as const, text: '', at: '2026-08-10T00:00:00Z', wuId: 'wu-1' },
      { id: 'c', kind: 'wu' as const, text: '', at: '2026-08-10T00:00:00Z', wuId: 'wu-x' },
      { id: 'd', kind: 'card' as const, text: '', at: '2026-08-10T00:00:00Z' },
    ];
    const { byReq, other } = attributeActivity(items, wuToReq);
    expect(byReq['REQ-0001'].map(i => i.id)).toEqual(['a', 'b']);
    expect(other.map(i => i.id)).toEqual(['c', 'd']);
  });

  it('wuId 有映射但条目自带 reqId 时，reqId 优先', () => {
    const items = [
      { id: 'a', kind: 'card' as const, text: '', at: '2026-08-10T00:00:00Z', reqId: 'REQ-0002', wuId: 'wu-1' },
    ];
    const { byReq } = attributeActivity(items, wuToReq);
    expect(byReq['REQ-0002'].map(i => i.id)).toEqual(['a']);
    expect(byReq['REQ-0001']).toBeUndefined();
  });
});

describe('deriveActivityRows — 「其他动态」降噪（同类相邻折叠 + 信号分级）', () => {
  const item = (id: string, over: Partial<ChannelActivityItem> = {}): ChannelActivityItem => ({
    id, kind: 'wu', text: `动态${id}`, at: '2026-08-10T00:00:00Z', ...over,
  });

  it('同型 card 相邻连刷 → 折叠为一条（代表取组内首条=最新，count 记折叠数）', () => {
    const rows = deriveActivityRows([
      item('c3', { kind: 'card', text: 'daily_reflection 卡片 · 每日洞察 8-10' }),
      item('c2', { kind: 'card', text: 'daily_reflection 卡片 · 每日洞察 8-09' }),
      item('c1', { kind: 'card', text: 'daily_reflection 卡片 · 每日洞察 8-08' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].item.id).toBe('c3');
    expect(rows[0].count).toBe(3);
  });

  it('同文 wu 条目相邻（执行失败连刷）→ 折叠；中间夹异文条目不跨条折叠', () => {
    const rows = deriveActivityRows([
      item('a2', { text: '执行失败：超时' }),
      item('a1', { text: '执行失败：超时' }),
      item('b1', { text: '已交付产物' }),
      item('a0', { text: '执行失败：超时' }),
    ]);
    expect(rows.map(r => [r.item.id, r.count])).toEqual([['a2', 2], ['b1', 1], ['a0', 1]]);
  });

  it('pinned（等待人工）→ signal，且不同 wuId 的 pinned 不互相折叠', () => {
    const rows = deriveActivityRows([
      item('w2', { text: '等待人工回复：选哪个？', pinned: true, wuId: 'wu-2', at: undefined }),
      item('w1', { text: '等待人工回复：选哪个？', pinned: true, wuId: 'wu-1', at: undefined }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.tone === 'signal')).toBe(true);
  });

  it('文本含 需要输入 / blocked / 阻塞 → signal', () => {
    const rows = deriveActivityRows([
      item('s1', { text: 'WU 需要输入：确认方案' }),
      item('s2', { text: '流水线 blocked：依赖未就绪' }),
      item('s3', { text: 'REQ 阻塞待处理' }),
    ]);
    expect(rows.every(r => r.tone === 'signal')).toBe(true);
  });

  it('card 条目（例行播报）→ routine；普通 wu/req 条目 → normal', () => {
    const rows = deriveActivityRows([
      item('c1', { kind: 'card', text: 'gc_proposal 卡片 · 候选清单' }),
      item('u1', { kind: 'wu', text: '普通执行进展' }),
      item('r1', { kind: 'req', text: 'REQ-0001 需求一 · open' }),
    ]);
    expect(rows.map(r => r.tone)).toEqual(['routine', 'normal', 'normal']);
  });

  it('空输入 → 空输出', () => {
    expect(deriveActivityRows([])).toEqual([]);
  });
});

describe('fmtRelTime', () => {
  it('分钟/小时/天 分档', () => {
    const now = Date.now();
    expect(fmtRelTime(new Date(now - 30_000).toISOString())).toBe('刚刚');
    expect(fmtRelTime(new Date(now - 5 * 60_000).toISOString())).toBe('5分钟前');
    expect(fmtRelTime(new Date(now - 3 * 3_600_000).toISOString())).toBe('3小时前');
    expect(fmtRelTime(new Date(now - 2 * 86_400_000).toISOString())).toBe('2天前');
  });
});
