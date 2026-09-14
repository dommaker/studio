// deriveStreamView（#322）：频道消息流渲染管线纯函数——从 ChannelDetailPage 渲染段反推行为断言。
// 覆盖：可见性（已完成折叠）、归组、过程消息折叠/展开、连续合并、日期分隔。
// 断言自现有 ChannelDetailPage*.test.tsx 行为反推，迁移后页面测试须保持全绿。
import { describe, it, expect } from 'vitest';
import { deriveStreamView, isMonitorAlert, navigableIdsOf, rootAnchorIdOf, type StreamUiState, type StreamItem, type ThreadReplyView } from '../streamView';
import type { ChannelMessage } from '../../api/channel';

const t0 = new Date('2026-08-19T10:00:00.000Z').getTime();
const iso = (offsetMin: number) => new Date(t0 + offsetMin * 60000).toISOString();

const msg = (id: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent', agentName: 'pm',
  content: `内容-${id}`, replyToId: null, meta: '{}', createdAt: iso(0), ...over,
});

const ui = (over: Partial<StreamUiState> = {}): StreamUiState => ({
  showCompleted: false,
  collapsedThreads: new Set(),
  expandedProcGroups: new Set(),
  expandedAlertGroups: new Set(),
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
  it('WU 锚点 + 回复 → thread 项；线程默认展开（折叠层级 4→2），replies 直接计算', () => {
    const view = deriveStreamView([
      msg('t1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      msg('t2', { workUnitId: 'WU-1', replyToId: 't1', createdAt: iso(1) }),
    ], ui());
    const threads = threadItems(view);
    expect(threads).toHaveLength(1);
    expect(threads[0].anchor.id).toBe('t1');
    expect(threads[0].replyCount).toBe(1);
    expect(threads[0].expanded).toBe(true);
    expect(threads[0].replies).toEqual([
      { kind: 'msg', message: expect.objectContaining({ id: 't2' }), compact: false },
    ]);
  });

  it('collapsedThreads 命中的线程收起：expanded=false，replies 不计算', () => {
    const view = deriveStreamView([
      msg('t1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      msg('t2', { workUnitId: 'WU-1', replyToId: 't1', createdAt: iso(1) }),
    ], ui({ collapsedThreads: new Set(['t1']) }));
    const thread = threadItems(view)[0];
    expect(thread.expanded).toBe(false);
    expect(thread.replies).toEqual([]);
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

// Phase 2（channel 上下游优化 AC2，docs/plans/2026-09-channel-upstream-downstream-ux.md）：
// 归组语义变更——anchor 条件从「workUnitId && !replyToId」放宽为「!replyToId && (workUnitId || 被回复过)」；
// 回复沿 replyToId 链挂最近线程根（多层拍平），链断裂落主流兜底。
describe('deriveStreamView — 线程归组泛化（Phase 2 AC2）', () => {
  it('普通消息互回（无 WU）→ 被回复消息成 anchor，回复进线程', () => {
    const view = deriveStreamView([
      msg('u1', { createdAt: iso(0) }),
      msg('u2', { replyToId: 'u1', createdAt: iso(1) }),
    ], ui());
    const threads = threadItems(view);
    expect(threads).toHaveLength(1);
    expect(threads[0].anchor.id).toBe('u1');
    expect(threads[0].replyCount).toBe(1);
    expect(messageItems(view)).toHaveLength(0);
  });

  it('多层回复（A→B→C）拍平进线程根 A：replyCount=2，B/C 同层按时序排列', () => {
    const view = deriveStreamView([
      msg('u1', { createdAt: iso(0) }),
      msg('u2', { replyToId: 'u1', createdAt: iso(1) }),
      msg('u3', { replyToId: 'u2', createdAt: iso(2) }),
    ], ui());
    const threads = threadItems(view);
    expect(threads).toHaveLength(1);
    expect(threads[0].anchor.id).toBe('u1');
    expect(threads[0].replyCount).toBe(2);
    expect(threads[0].replies.map(r => (r as { message: ChannelMessage }).message.id)).toEqual(['u2', 'u3']);
  });

  it('链上中间节点落主流（promote 命中）→ 后续回复透过它仍挂进线程根', () => {
    const view = deriveStreamView([
      msg('u1', { createdAt: iso(0) }),
      msg('q2', { replyToId: 'u1', createdAt: iso(1) }),
      msg('u3', { replyToId: 'q2', createdAt: iso(2) }),
    ], ui({ promotedQuestionIds: new Set(['q2']) }));
    const threads = threadItems(view);
    expect(threads).toHaveLength(1);
    expect(threads[0].anchor.id).toBe('u1');
    expect(threads[0].replyCount).toBe(1); // 仅 u3；q2 提升主流不进线程
    expect(messageItems(view).map(i => i.message.id)).toEqual(['q2']);
  });

  it('父消息未加载（链断裂）→ 回复落主流当普通消息（兜底语义不变）', () => {
    const view = deriveStreamView([
      msg('orphan', { replyToId: 'ghost', createdAt: iso(0) }),
      msg('m1', { createdAt: iso(1) }),
    ], ui());
    expect(threadItems(view)).toHaveLength(0);
    expect(messageItems(view).map(i => i.message.id)).toEqual(['orphan', 'm1']);
  });

  it('无回复的普通消息不成 anchor（仍是主流普通消息）', () => {
    const view = deriveStreamView([
      msg('m1', { createdAt: iso(0) }),
      msg('m2', { createdAt: iso(1) }),
    ], ui());
    expect(threadItems(view)).toHaveLength(0);
    expect(messageItems(view)).toHaveLength(2);
  });
});

describe('rootAnchorIdOf（Phase 2：页面定位与 streamView 共用的线程根解析）', () => {
  const byIdOf = (ms: ChannelMessage[]) => new Map(ms.map(m => [m.id, m]));

  it('多层链返回线程根 id；直接回复返回其父（链顶）', () => {
    const ms = [
      msg('a', { createdAt: iso(0) }),
      msg('b', { replyToId: 'a', createdAt: iso(1) }),
      msg('c', { replyToId: 'b', createdAt: iso(2) }),
    ];
    const byId = byIdOf(ms);
    expect(rootAnchorIdOf(ms[1], byId)).toBe('a');
    expect(rootAnchorIdOf(ms[2], byId)).toBe('a');
  });

  it('自身无 replyToId → null（不在任何线程里）', () => {
    const ms = [msg('a')];
    expect(rootAnchorIdOf(ms[0], byIdOf(ms))).toBeNull();
  });

  it('父消息未加载（链断裂）→ null', () => {
    const ms = [msg('b', { replyToId: 'ghost' })];
    expect(rootAnchorIdOf(ms[0], byIdOf(ms))).toBeNull();
  });

  it('链中间节点未加载 → null', () => {
    const ms = [
      msg('a', { createdAt: iso(0) }),
      msg('c', { replyToId: 'b', createdAt: iso(2) }), // b 未加载
    ];
    expect(rootAnchorIdOf(ms[1], byIdOf(ms))).toBeNull();
  });

  it('replyToId 成环 → null（防御，不死循环）', () => {
    const ms = [
      msg('x', { replyToId: 'y' }),
      msg('y', { replyToId: 'x' }),
    ];
    const byId = byIdOf(ms);
    expect(rootAnchorIdOf(ms[0], byId)).toBeNull();
    expect(rootAnchorIdOf(ms[1], byId)).toBeNull();
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
    const view = deriveStreamView(threadFixture(), ui());
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
    ], ui()); // 线程默认展开
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
    ], ui({ // 线程默认展开，无需展开标记
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
    ], ui()); // 线程默认展开
    const replies = threadItems(view)[0].replies;
    // p2-p5 折叠成组（切断合并），p6 组后首条 → 不省头
    expect(replies[1]).toMatchObject({ kind: 'msg', compact: false });
  });

  it('线程内未折叠的连续回复：后一条省头', () => {
    const view = deriveStreamView([
      msg('p1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      msg('p2', { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(1) }),
      msg('p3', { workUnitId: 'WU-1', replyToId: 'p1', createdAt: iso(2) }),
    ], ui()); // 线程默认展开
    const replies = threadItems(view)[0].replies;
    expect(replies.map(r => (r as { compact?: boolean }).compact)).toEqual([false, true]);
  });
});

// Phase 3（channel 上下游优化 AC3，docs/plans/2026-09-channel-upstream-downstream-ux.md）：
// 主流 monitor 告警折叠——连续 ≥3 条 isMonitorAlert 的 message 项收成 alert-group
// （Studio 署名 + 无卡 + 非 NEED_INPUT 等待中 + [CRITICAL]/[WARNING] 前缀）。
describe('deriveStreamView — monitor 告警折叠（Phase 3 AC3）', () => {
  const alert = (id: string, level: 'CRITICAL' | 'WARNING', offsetMin: number, over: Partial<ChannelMessage> = {}) =>
    msg(id, {
      authorType: 'agent', agentName: 'Studio',
      content: `[${level}] **[Monitor]** 告警内容-${id}`,
      createdAt: iso(offsetMin), ...over,
    });
  const alertGroups = (view: { items: StreamItem[] }) =>
    view.items.filter((i): i is Extract<StreamItem, { kind: 'alert-group' }> => i.kind === 'alert-group');

  it('连续 ≥3 条告警收成 alert-group：severity 计数 + key = alerts-<首条id>，默认折叠', () => {
    const view = deriveStreamView([
      alert('a1', 'CRITICAL', 0),
      alert('a2', 'WARNING', 1),
      alert('a3', 'CRITICAL', 2),
      alert('a4', 'WARNING', 3),
    ], ui());
    const groups = alertGroups(view);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('alerts-a1');
    expect(groups[0].messages.map(m => m.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(groups[0].criticalCount).toBe(2);
    expect(groups[0].warningCount).toBe(2);
    expect(groups[0].expanded).toBe(false);
    expect(messageItems(view)).toHaveLength(0);
  });

  it('仅 2 条连续告警不折叠', () => {
    const view = deriveStreamView([alert('a1', 'CRITICAL', 0), alert('a2', 'WARNING', 1)], ui());
    expect(alertGroups(view)).toHaveLength(0);
    expect(messageItems(view).map(i => i.message.id)).toEqual(['a1', 'a2']);
  });

  it('连续段被普通消息打断：3 + 1 + 3 → 两个组；2 + 1 + 2 → 不折', () => {
    const view = deriveStreamView([
      alert('a1', 'CRITICAL', 0), alert('a2', 'CRITICAL', 1), alert('a3', 'WARNING', 2),
      msg('m1', { createdAt: iso(3) }),
      alert('a4', 'WARNING', 4), alert('a5', 'WARNING', 5), alert('a6', 'CRITICAL', 6),
    ], ui());
    const groups = alertGroups(view);
    expect(groups.map(g => g.key)).toEqual(['alerts-a1', 'alerts-a4']);
    expect(messageItems(view).map(i => i.message.id)).toEqual(['m1']);

    const short = deriveStreamView([
      alert('b1', 'CRITICAL', 0), alert('b2', 'CRITICAL', 1),
      msg('m1', { createdAt: iso(2) }),
      alert('b3', 'WARNING', 3), alert('b4', 'WARNING', 4),
    ], ui());
    expect(alertGroups(short)).toHaveLength(0);
  });

  it('NEED_INPUT 等待中的 Studio 消息不折叠（保留 agent 形态供回复），并打断连续段', () => {
    const view = deriveStreamView([
      alert('a1', 'CRITICAL', 0),
      alert('q2', 'WARNING', 1, { workUnitId: 'WU-1' }),
      alert('a3', 'CRITICAL', 2),
      alert('a4', 'CRITICAL', 3),
    ], ui({ isWaitingForInput: m => m.id === 'q2' }));
    expect(alertGroups(view)).toHaveLength(0); // 两段各 1/2 条，不足 3
    expect(messageItems(view)).toHaveLength(3);
    // q2 带 WU 且无 replyToId → 归组为 thread anchor（同样打断连续段、不参与折叠）
    expect(threadItems(view).map(t => t.anchor.id)).toEqual(['q2']);
  });

  it('跨天告警段：组以首条消息日期参与主流日期分隔，后续项跨天仍出分隔', () => {
    const day2 = new Date(t0 + 2 * 86400000).toISOString();
    const day3 = new Date(t0 + 3 * 86400000).toISOString();
    const view = deriveStreamView([
      alert('a1', 'CRITICAL', 0),
      alert('a2', 'WARNING', 1),
      alert('a3', 'CRITICAL', 0, { createdAt: day2 }), // 组内跨天
      msg('m1', { createdAt: day3 }),
    ], ui());
    const groups = alertGroups(view);
    expect(groups).toHaveLength(1);
    expect(groups[0].showDate).toBe(true); // 首项必出分隔（按首条消息日期）
    const m1 = messageItems(view)[0];
    expect(m1.showDate).toBe(true); // 组后消息跨天仍出分隔
    expect(m1.dateLabel).not.toBe(groups[0].dateLabel);
  });

  it('expandedAlertGroups 命中 → alert-group expanded=true', () => {
    const view = deriveStreamView(
      [alert('a1', 'CRITICAL', 0), alert('a2', 'WARNING', 1), alert('a3', 'CRITICAL', 2)],
      ui({ expandedAlertGroups: new Set(['alerts-a1']) }),
    );
    expect(alertGroups(view)[0].expanded).toBe(true);
  });

  it('[INFO]/无前缀的 Studio 播报不算告警，不折叠', () => {
    const view = deriveStreamView([
      msg('s1', { agentName: 'Studio', content: '[INFO] 普通播报', createdAt: iso(0) }),
      msg('s2', { agentName: 'Studio', content: '无前缀播报', createdAt: iso(1) }),
      msg('s3', { agentName: 'Studio', content: '[INFO] 又一条', createdAt: iso(2) }),
    ], ui());
    expect(alertGroups(view)).toHaveLength(0);
    expect(messageItems(view)).toHaveLength(3);
  });
});

describe('isMonitorAlert（Phase 3 AC3 判定）', () => {
  const noWait = () => false;
  it('Studio + 无卡 + 非等待 + severity 前缀 → true', () => {
    expect(isMonitorAlert(
      msg('a1', { agentName: 'Studio', content: '[CRITICAL] x' }), noWait,
    )).toBe(true);
    expect(isMonitorAlert(
      msg('a2', { agentName: 'Studio', content: '[WARNING] y' }), noWait,
    )).toBe(true);
  });
  it('非 Studio / 带卡 / 等待中 / 无前缀 → false', () => {
    expect(isMonitorAlert(msg('b1', { agentName: 'pm', content: '[CRITICAL] x' }), noWait)).toBe(false);
    expect(isMonitorAlert(msg('b2', {
      agentName: 'Studio', content: '[CRITICAL] x',
      meta: JSON.stringify({ cardType: 'knowledge_proposal' }),
    }), noWait)).toBe(false);
    expect(isMonitorAlert(msg('b3', { agentName: 'Studio', content: '[CRITICAL] x' }), () => true)).toBe(false);
    expect(isMonitorAlert(msg('b4', { agentName: 'Studio', content: '[INFO] x' }), noWait)).toBe(false);
    expect(isMonitorAlert(msg('b5', { authorType: 'human', agentName: undefined, content: '[CRITICAL] x' }), noWait)).toBe(false);
  });
});

// Phase 3（AC5）：j/k 键盘导航的可导航 id 序列——message / thread anchor / 展开的 thread replies /
// 展开的 alert-group 内消息；折叠组（thread/proc-group/alert-group）与日期分隔跳过。
describe('navigableIdsOf（Phase 3 AC5）', () => {
  it('主流 message 项 + thread anchor + 展开 replies 按序拍平', () => {
    const view = deriveStreamView([
      msg('m1', { createdAt: iso(0) }),
      msg('a1', { createdAt: iso(1) }),
      msg('r1', { replyToId: 'a1', createdAt: iso(2) }),
      msg('m2', { createdAt: iso(3) }),
    ], ui());
    expect(navigableIdsOf(view.items)).toEqual(['m1', 'a1', 'r1', 'm2']);
  });

  it('收起的 thread 只留 anchor；折叠 proc-group 跳过组内消息', () => {
    const collapsed = deriveStreamView([
      msg('a1', { createdAt: iso(0) }),
      msg('r1', { replyToId: 'a1', createdAt: iso(1) }),
    ], ui({ collapsedThreads: new Set(['a1']) }));
    expect(navigableIdsOf(collapsed.items)).toEqual(['a1']);

    // 4 条连续过程回复：中间 3 条折进 proc-group（末条恒为里程碑）
    const view = deriveStreamView([
      msg('a1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      ...[2, 3, 4, 5].map(i => msg(`p${i}`, { workUnitId: 'WU-1', replyToId: 'a1', createdAt: iso(i - 1) })),
    ], ui());
    expect(navigableIdsOf(view.items)).toEqual(['a1', 'p5']);
    // 展开 proc-group → 组内消息可导航
    const expanded = deriveStreamView([
      msg('a1', { workUnitId: 'WU-1', createdAt: iso(0) }),
      ...[2, 3, 4, 5].map(i => msg(`p${i}`, { workUnitId: 'WU-1', replyToId: 'a1', createdAt: iso(i - 1) })),
    ], ui({ expandedProcGroups: new Set(['proc-p2']) }));
    expect(navigableIdsOf(expanded.items)).toEqual(['a1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('折叠 alert-group 整组跳过；展开后组内消息可导航', () => {
    const alerts = (over: Partial<StreamUiState> = {}) => deriveStreamView([
      msg('al1', { agentName: 'Studio', content: '[CRITICAL] x1', createdAt: iso(0) }),
      msg('al2', { agentName: 'Studio', content: '[WARNING] x2', createdAt: iso(1) }),
      msg('al3', { agentName: 'Studio', content: '[CRITICAL] x3', createdAt: iso(2) }),
      msg('m9', { createdAt: iso(3) }),
    ], ui(over));
    expect(navigableIdsOf(alerts().items)).toEqual(['m9']);
    expect(navigableIdsOf(alerts({ expandedAlertGroups: new Set(['alerts-al1']) }).items))
      .toEqual(['al1', 'al2', 'al3', 'm9']);
  });
});
