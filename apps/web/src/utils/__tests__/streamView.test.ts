// deriveStreamView（#322）：频道消息流渲染管线纯函数——从 ChannelDetailPage 渲染段反推行为断言。
// 覆盖：可见性（已完成折叠）、归组、过程消息折叠/展开、连续合并、日期分隔。
// 断言自现有 ChannelDetailPage*.test.tsx 行为反推，迁移后页面测试须保持全绿。
import { describe, it, expect } from 'vitest';
import { deriveStreamView, type StreamUiState, type StreamItem, type ThreadReplyView } from '../streamView';
import type { ChannelMessage } from '../../api/channel';

const t0 = new Date('2026-08-19T10:00:00.000Z').getTime();
const iso = (offsetMin: number) => new Date(t0 + offsetMin * 60000).toISOString();

const msg = (id: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent', agentName: 'pm',
  content: `内容-${id}`, replyToId: null, meta: '{}', createdAt: iso(0), ...over,
});

const ui = (over: Partial<StreamUiState> = {}): StreamUiState => ({
  showCompleted: false,
  expandedThreads: new Set(),
  expandedProcGroups: new Set(),
  promotedQuestionIds: new Set(),
  isWaitingForInput: () => false,
  ...over,
});

const doneMsg = (id: string, offsetMin: number) =>
  msg(id, { meta: JSON.stringify({ status: 'done' }), createdAt: iso(offsetMin) });

const itemsOf = (view: { items: StreamItem[] }) => view.items;
const messageItems = (view: { items: StreamItem[] }) =>
  view.items.filter((i): i is Extract<StreamItem, { kind: 'message' }> => i.kind === 'message');
const threadItems = (view: { items: StreamItem[] }) =>
  view.items.filter((i): i is Extract<StreamItem, { kind: 'thread' }> => i.kind === 'thread');

describe('deriveStreamView — 可见性（已完成折叠）', () => {
  it('默认折叠已完成消息：活跃全留 + 最近 2 条已完成，按 createdAt 升序', () => {
    const view = deriveStreamView([
      doneMsg('c1', 0), doneMsg('c2', 1), doneMsg('c3', 2), msg('a1', { createdAt: iso(3) }),
    ], ui());
    expect(itemsOf(view).map(i => (i.kind === 'message' ? i.message.id : i.anchor.id)))
      .toEqual(['c2', 'c3', 'a1']);
    expect(view.completedCount).toBe(3);
  });

  it('showCompleted=true → 全部可见', () => {
    const view = deriveStreamView(
      [doneMsg('c1', 0), doneMsg('c2', 1), doneMsg('c3', 2), msg('a1', { createdAt: iso(3) })],
      ui({ showCompleted: true }),
    );
    expect(itemsOf(view)).toHaveLength(4);
  });

  it('输入乱序 → 输出按 createdAt 升序归位', () => {
    const view = deriveStreamView(
      [msg('m2', { createdAt: iso(5) }), msg('m1', { createdAt: iso(1) })],
      ui(),
    );
    expect(messageItems(view).map(i => i.message.id)).toEqual(['m1', 'm2']);
  });

  it('completed 判定覆盖全部终态 status', () => {
    const statuses = ['done', 'confirmed', 'rejected', 'deprecated', 'error'];
    const view = deriveStreamView(
      statuses.map((s, i) => msg(`s${i}`, { meta: JSON.stringify({ status: s }), createdAt: iso(i) })),
      ui(),
    );
    expect(view.completedCount).toBe(5);
    // 只留最近 2 条
    expect(messageItems(view).map(i => i.message.id)).toEqual(['s3', 's4']);
  });
});

describe('deriveStreamView — 线程归组', () => {
  it('WU 锚点 + 回复 → thread 项；折叠态 replies 不计算', () => {
    const view = deriveStreamView([
      msg('t1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      msg('t2', { workUnitId: 'WU-1', replyToId: 't1', createdAt: iso(1) }),
    ], ui());
    const threads = threadItems(view);
    expect(threads).toHaveLength(1);
    expect(threads[0].anchor.id).toBe('t1');
    expect(threads[0].replyCount).toBe(1);
    expect(threads[0].expanded).toBe(false);
    expect(threads[0].replies).toEqual([]);
  });

  it('expandedThreads 命中的线程展开并计算 replies', () => {
    const view = deriveStreamView([
      msg('t1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      msg('t2', { workUnitId: 'WU-1', replyToId: 't1', createdAt: iso(1) }),
    ], ui({ expandedThreads: new Set(['t1']) }));
    const thread = threadItems(view)[0];
    expect(thread.expanded).toBe(true);
    expect(thread.replies).toEqual([
      { kind: 'msg', message: expect.objectContaining({ id: 't2' }), compact: false },
    ]);
  });

  it('promotedQuestionIds 命中的回复提升到主流（不进折叠线程）', () => {
    const view = deriveStreamView([
      msg('t1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      msg('q2', { workUnitId: 'WU-1', replyToId: 't1', createdAt: iso(1) }),
    ], ui({ promotedQuestionIds: new Set(['q2']) }));
    expect(threadItems(view)[0].replyCount).toBe(0);
    expect(messageItems(view).map(i => i.message.id)).toEqual(['q2']);
  });
});

describe('deriveStreamView — 日期分隔', () => {
  it('首项必出分隔；同日后续项不出；跨日出分隔', () => {
    const view = deriveStreamView([
      msg('d1', { createdAt: iso(0) }),
      msg('d2', { createdAt: iso(10) }),
      msg('d3', { createdAt: new Date(t0 + 2 * 86400000).toISOString() }),
    ], ui());
    const items = messageItems(view);
    expect(items.map(i => i.showDate)).toEqual([true, false, true]);
  });

  it('今天的消息标签为「今天」，昨天为「昨天」，更早为日期串', () => {
    const now = Date.now();
    const view = deriveStreamView([
      msg('old', { createdAt: new Date(now - 3 * 86400000).toISOString() }),
      msg('y', { createdAt: new Date(now - 86400000).toISOString() }),
      msg('t', { createdAt: new Date(now).toISOString() }),
    ], ui());
    const items = messageItems(view);
    expect(items[2].dateLabel).toBe('今天');
    expect(items[1].dateLabel).toBe('昨天');
    expect(items[0].dateLabel).toBe(
      new Date(now - 3 * 86400000).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }),
    );
  });
});

describe('deriveStreamView — 连续合并（compact）', () => {
  it('同作者 5 分钟内连续消息合并；跨作者/超窗不合并', () => {
    const view = deriveStreamView([
      msg('a1', { authorType: 'human', agentName: undefined, createdAt: iso(0) }),
      msg('a2', { authorType: 'human', agentName: undefined, createdAt: iso(2) }),
      msg('a3', { createdAt: iso(3) }),
      msg('a4', { createdAt: iso(4) }),
      msg('a5', { createdAt: iso(10) }), // 超 5min 窗
    ], ui());
    expect(messageItems(view).map(i => i.compact)).toEqual([false, true, false, true, false]);
  });

  it('日期分隔切断合并', () => {
    const view = deriveStreamView([
      msg('d1', { createdAt: iso(0) }),
      msg('d2', { createdAt: new Date(t0 + 2 * 86400000).toISOString() }),
    ], ui());
    expect(messageItems(view)[1].compact).toBe(false);
  });

  it('系统播报与卡片消息既不并入别人也不被别人并入', () => {
    const view = deriveStreamView([
      msg('s1', { agentName: 'Studio', createdAt: iso(0) }),
      msg('s2', { agentName: 'Studio', createdAt: iso(1) }),
      msg('m1', { createdAt: iso(2) }),
      msg('card', {
        createdAt: iso(3),
        meta: JSON.stringify({ cardType: 'knowledge_proposal', status: 'ready' }),
      }),
      msg('m2', { createdAt: iso(4) }),
    ], ui());
    expect(messageItems(view).map(i => i.compact)).toEqual([false, false, false, false, false]);
  });

  it('promoted 提问消息不参与合并：自身不省头，后一条也不被吃头', () => {
    const view = deriveStreamView([
      msg('m1', { createdAt: iso(0) }),
      msg('q2', { createdAt: iso(1) }),
      msg('m3', { createdAt: iso(2) }),
    ], ui({ promotedQuestionIds: new Set(['q2']) }));
    expect(messageItems(view).map(i => i.compact)).toEqual([false, false, false]);
  });
});

describe('deriveStreamView — 线程内过程消息折叠', () => {
  const threadFixture = () => [
    msg('p1', { workUnitId: 'WU-1', createdAt: iso(0) }),
    ...[2, 3, 4, 5].map(i => msg(`p${i}`, { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(i - 1) })),
    msg('p6', { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(5) }), // 末条里程碑
  ];

  it('连续 ≥3 条过程消息收成 proc-group；末条（最新状态）恒为里程碑', () => {
    const view = deriveStreamView(threadFixture(), ui({ expandedThreads: new Set(['p1']) }));
    const replies = threadItems(view)[0].replies;
    expect(replies).toHaveLength(2);
    const group = replies[0] as Extract<ThreadReplyView, { kind: 'proc-group' }>;
    expect(group.kind).toBe('proc-group');
    expect(group.key).toBe('proc-p2');
    expect(group.messages.map(m => m.id)).toEqual(['p2', 'p3', 'p4', 'p5']);
    expect(group.expanded).toBe(false);
    expect(replies[1]).toMatchObject({ kind: 'msg', message: { id: 'p6' } });
  });

  it('不足 3 条连续过程消息不折叠', () => {
    const view = deriveStreamView([
      msg('p1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      msg('p2', { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(1) }),
      msg('p3', { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(2) }),
    ], ui({ expandedThreads: new Set(['p1']) }));
    const replies = threadItems(view)[0].replies;
    expect(replies.map(r => r.kind)).toEqual(['msg', 'msg']);
  });

  it('里程碑不折叠：人类消息 / 卡片消息 / 等待回复', () => {
    const view = deriveStreamView([
      msg('p1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      ...[2, 3, 4].map(i => msg(`p${i}`, { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(i - 1) })),
      msg('h5', { authorType: 'human', agentName: undefined, workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(4) }),
      ...[6, 7, 8].map(i => msg(`p${i}`, { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(i - 1) })),
      msg('card9', {
        workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(8),
        meta: JSON.stringify({ cardType: 'knowledge_proposal', status: 'ready' }),
      }),
      ...[10, 11, 12].map(i => msg(`p${i}`, { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(i - 1) })),
      msg('w13', { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(12) }),
    ], ui({
      expandedThreads: new Set(['p1']),
      isWaitingForInput: m => m.id === 'w13',
    }));
    const replies = threadItems(view)[0].replies;
    expect(replies.map(r => r.kind)).toEqual([
      'proc-group', 'msg', 'proc-group', 'msg', 'proc-group', 'msg',
    ]);
    expect((replies[1] as { message: ChannelMessage }).message.id).toBe('h5');
    expect((replies[3] as { message: ChannelMessage }).message.id).toBe('card9');
    expect((replies[5] as { message: ChannelMessage }).message.id).toBe('w13');
  });

  it('expandedProcGroups 命中 → proc-group expanded=true', () => {
    const view = deriveStreamView(threadFixture(), ui({
      expandedThreads: new Set(['p1']),
      expandedProcGroups: new Set(['proc-p2']),
    }));
    const group = threadItems(view)[0].replies[0] as Extract<ThreadReplyView, { kind: 'proc-group' }>;
    expect(group.expanded).toBe(true);
  });

  it('线程内同作者连续回复合并（首条不并入锚点）；proc-group 切断合并', () => {
    const view = deriveStreamView([
      msg('p1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      ...[2, 3, 4, 5].map(i => msg(`p${i}`, { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(i - 1) })),
      msg('p6', { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(5) }),
    ], ui({ expandedThreads: new Set(['p1']) }));
    const replies = threadItems(view)[0].replies;
    // p2-p5 折叠成组（切断合并），p6 组后首条 → 不省头
    expect(replies[1]).toMatchObject({ kind: 'msg', compact: false });
  });

  it('线程内未折叠的连续回复：后一条省头', () => {
    const view = deriveStreamView([
      msg('p1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      msg('p2', { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(1) }),
      msg('p3', { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(2) }),
    ], ui({ expandedThreads: new Set(['p1']) }));
    const replies = threadItems(view)[0].replies;
    expect(replies.map(r => (r as { compact?: boolean }).compact)).toEqual([false, true]);
  });
});
