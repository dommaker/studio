// #394 频道动态右栏纯函数：四站 stepper 推导 / 动态条目构建 / REQ 归属分流
import { describe, it, expect } from 'vitest';
import {
  deriveChainSteps,
  buildChannelActivity,
  attributeActivity,
  fmtRelTime,
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

describe('buildChannelActivity — 动态条目', () => {
  it('卡片消息（meta.cardType，string meta）→ card 条目，带 wuId', () => {
    const items = buildChannelActivity({
      messages: [msg('m1', { meta: JSON.stringify({ cardType: 'analysis_confirm' }), workUnitId: 'wu-1', content: '第一行\n第二行' })],
      reqs: [], waitingWus: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'm1', kind: 'card', wuId: 'wu-1' });
    expect(items[0].text).toContain('analysis_confirm');
    expect(items[0].text).not.toContain('第二行');
  });

  it('agent WU 消息 → wu 条目；人类消息与普通 agent 消息（无 WU）不进动态', () => {
    const items = buildChannelActivity({
      messages: [
        msg('m1', { workUnitId: 'wu-1' }),
        msg('m2', { authorType: 'human', workUnitId: 'wu-1' }),
        msg('m3'),
      ],
      reqs: [], waitingWus: [],
    });
    expect(items.map(i => i.id)).toEqual(['m1']);
    expect(items[0].kind).toBe('wu');
  });

  it('REQ 与 NEED_INPUT 待办进动态；整体按时间倒序', () => {
    const items = buildChannelActivity({
      messages: [msg('m1', { workUnitId: 'wu-1', createdAt: '2026-08-10T00:00:00Z' })],
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

  it('坏 meta（非 JSON）静默跳过 card 判定，不炸', () => {
    const items = buildChannelActivity({
      messages: [msg('m1', { meta: '{bad json', workUnitId: 'wu-1' })],
      reqs: [], waitingWus: [],
    });
    expect(items[0].kind).toBe('wu');
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

describe('fmtRelTime', () => {
  it('分钟/小时/天 分档', () => {
    const now = Date.now();
    expect(fmtRelTime(new Date(now - 30_000).toISOString())).toBe('刚刚');
    expect(fmtRelTime(new Date(now - 5 * 60_000).toISOString())).toBe('5分钟前');
    expect(fmtRelTime(new Date(now - 3 * 3_600_000).toISOString())).toBe('3小时前');
    expect(fmtRelTime(new Date(now - 2 * 86_400_000).toISOString())).toBe('2天前');
  });
});
