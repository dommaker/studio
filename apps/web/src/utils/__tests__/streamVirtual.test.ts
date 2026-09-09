// 频道消息流虚拟化纯函数（#325，ADR 2026-08-24 channel-stream-virtualization）：
// key 稳定性、mid→item 索引映射、prepend 锚点补偿数学、末行钉底判定。
// jsdom 无布局不可测 virtualizer 本体，行为拆纯函数在此单测；hook/组件侧只负责接线。
import { describe, it, expect } from 'vitest';
import {
  STREAM_VIRTUAL_ENABLED,
  streamItemKey,
  buildMessageToItemIndex,
  anchorScrollTopAfterPrepend,
  virtualizerScrollSettled,
  planFineAdjust,
  FINE_ADJUST_MISSING_GRACE_FRAMES,
  ROW_HEIGHT_ESTIMATE,
  estimateStreamItemSize,
} from '../streamVirtual';
import { deriveStreamView, type StreamUiState } from '../streamView';
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
  promotedQuestionIds: new Set(),
  isWaitingForInput: () => false,
  ...over,
});

/** 线程组：anchor 带 workUnitId，replies 经 replyToId 挂入 */
const threadView = (replyCount: number, over: Partial<StreamUiState> = {}) => {
  const replies = Array.from({ length: replyCount }, (_, i) =>
    msg(`r${i + 1}`, { replyToId: 'a1', createdAt: iso(i + 1) }));
  return deriveStreamView([msg('a1', { workUnitId: 'wu-1' }), ...replies], ui(over));
};

describe('STREAM_VIRTUAL_ENABLED（测试 seam）', () => {
  it('vitest 环境（MODE=test）下关闭——jsdom 无布局，既有页面测试走全量渲染', () => {
    expect(STREAM_VIRTUAL_ENABLED).toBe(false);
  });
});

describe('streamItemKey', () => {
  it('message 项 = message.id；thread 项 = anchor.id（prepend 下稳定）', () => {
    const view = deriveStreamView([msg('m1'), msg('m2', { createdAt: iso(1) })], ui());
    const [i1, i2] = view.items;
    expect(streamItemKey(i1)).toBe('m1');
    expect(streamItemKey(i2)).toBe('m2');
    const t = threadView(1).items[0];
    expect(streamItemKey(t)).toBe('a1');
  });
});

describe('buildMessageToItemIndex', () => {
  it('message 项：消息 id → 自身 index', () => {
    const view = deriveStreamView([msg('m1'), msg('m2', { createdAt: iso(1) })], ui());
    const map = buildMessageToItemIndex(view.items);
    expect(map.get('m1')).toBe(0);
    expect(map.get('m2')).toBe(1);
  });

  it('thread 折叠态（collapsedThreads 命中）：anchor id → thread index；折叠 replies 不在视图模型中，不入映射（与虚拟化前 DOM 查询行为对齐）', () => {
    const map = buildMessageToItemIndex(threadView(3, { collapsedThreads: new Set(['a1']) }).items);
    expect(map.get('a1')).toBe(0);
    // 折叠态 replies 未渲染（deriveStreamView 不计算），锚点捕获/恢复本就不可能命中——维持现状兜底语义
    expect(map.get('r1')).toBeUndefined();
    expect(map.get('r3')).toBeUndefined();
  });

  it('thread 展开（默认）+ 过程组折叠：组内消息 id 同样映射到 thread index', () => {
    // 5 条 agent 回复连续非里程碑 → 前几条折进 proc-group（里程碑含最后一条）
    const view = threadView(5);
    const map = buildMessageToItemIndex(view.items);
    for (const id of ['a1', 'r1', 'r2', 'r3', 'r4', 'r5']) {
      expect(map.get(id)).toBe(0);
    }
  });

  it('混合序列：thread 后的 message 项 index 顺延', () => {
    const view = deriveStreamView([
      msg('a1', { workUnitId: 'wu-1' }),
      msg('r1', { replyToId: 'a1', createdAt: iso(1) }),
      msg('m9', { createdAt: iso(2) }),
    ], ui());
    const map = buildMessageToItemIndex(view.items);
    expect(map.get('a1')).toBe(0);
    expect(map.get('m9')).toBe(1);
  });
});

describe('anchorScrollTopAfterPrepend（验证约束 1：measurements 数据源，非 DOM 查询）', () => {
  it('scrollTop = item 新 start + item 内偏移 - 锚行视口相对 top（start 已含 scrollMargin）', () => {
    expect(anchorScrollTopAfterPrepend({
      newItemStart: 9190,
      withinItemOffset: 12,
      anchorTop: -2,
    })).toBe(9190 + 12 - (-2));
  });

  it('锚行在视口中部（top=300）时补偿后仍停在该视口位置', () => {
    const scrollTop = anchorScrollTopAfterPrepend({
      newItemStart: 5000, withinItemOffset: 0, anchorTop: 300,
    });
    // 补偿后锚行视口相对 top = (item start + within) - scrollTop = 300
    expect(5000 - scrollTop).toBe(300);
  });
});

describe('virtualizerScrollSettled（#339 收敛判定，virtual-core 3.17.8 内部字段锚定）', () => {
  it('scrollState 为 null/undefined/缺失 → 已收敛（含未开始滚动与 5s 上限截断后的终态）', () => {
    expect(virtualizerScrollSettled({ scrollState: null })).toBe(true);
    expect(virtualizerScrollSettled({})).toBe(true);
    expect(virtualizerScrollSettled(null)).toBe(true);
    expect(virtualizerScrollSettled(undefined)).toBe(true);
  });

  it('scrollState 非空（reconcile 循环在跑）→ 未收敛', () => {
    expect(virtualizerScrollSettled({ scrollState: { index: 7, align: 'start', startedAt: 1, stableFrames: 0 } })).toBe(false);
  });
});

describe('planFineAdjust（#339 精校正第二段决策——全部分支在此可测，hook 只机械接线）', () => {
  const pending = { mid: 'm9', top: 3333 };
  const base = { pending, settled: true, anchorTop: 83 as number | null, settledMissingFrames: 0, readerScrollInFlight: false };

  it('收敛前一律 wait——锚行已进 DOM 也不落地（reconcile 仍在改写 scrollTop，落地即被踩掉 = issue #339 根因）', () => {
    expect(planFineAdjust({ ...base, settled: false, anchorTop: null, readerScrollInFlight: true })).toEqual({ action: 'wait' });
  });

  it('未归类滚动在途（读者滚动事件尚未派发）→ abandon：读者意图优先，行已在 DOM 也不拽回', () => {
    expect(planFineAdjust({ ...base, readerScrollInFlight: true })).toEqual({ action: 'abandon' });
  });

  it('收敛后锚行进 DOM → apply：delta = 当前 top - 存档 top，加到 scrollTop 上锚行回到存档 top', () => {
    const d = planFineAdjust(base);
    if (d.action !== 'apply') throw new Error(`expected apply, got ${d.action}`);
    expect(d.delta).toBe(83 - 3333);
    // 落点验证：scroll 后锚行视口相对 top = anchorTop - delta = 存档 top（浏览器 clamp 前的数学目标）
    expect(83 - d.delta).toBe(3333);

    // 首行部分露出（负 top）同构成立
    const d2 = planFineAdjust({ ...base, pending: { mid: 'm1', top: -40 }, anchorTop: 0 });
    if (d2.action !== 'apply') throw new Error(`expected apply, got ${d2.action}`);
    expect(d2.delta).toBe(40);
    expect(0 - d2.delta).toBe(-40);
  });

  it('收敛后锚行缺席：宽限期内 wait（settle 观察帧可能早于锚行 React 提交一拍），连续缺席超宽限才 abandon', () => {
    expect(planFineAdjust({ ...base, anchorTop: null, settledMissingFrames: 1 })).toEqual({ action: 'wait' });
    expect(planFineAdjust({ ...base, anchorTop: null, settledMissingFrames: FINE_ADJUST_MISSING_GRACE_FRAMES - 1 })).toEqual({ action: 'wait' });
    expect(planFineAdjust({ ...base, anchorTop: null, settledMissingFrames: FINE_ADJUST_MISSING_GRACE_FRAMES })).toEqual({ action: 'abandon' });
  });

  it('缺席中途锚行出现 → 正常 apply（宽限计数清零是调用方职责，纯函数只看当帧）', () => {
    expect(planFineAdjust({ ...base, anchorTop: 120, settledMissingFrames: 3 })).toEqual({ action: 'apply', delta: 120 - 3333 });
  });
});

describe('estimateStreamItemSize（#450 分型静态估计：分类逻辑全量可测，档位值见报告附录采样）', () => {
  const E = ROW_HEIGHT_ESTIMATE;
  const first = (msgs: ChannelMessage[], over: Partial<StreamUiState> = {}) =>
    deriveStreamView(msgs, ui(over)).items;

  it('agent 文档流（非 Studio 无卡）非 compact → agent 档', () => {
    const [item] = first([msg('m1')]);
    expect(estimateStreamItemSize(item)).toBe(E.date + E.agent); // 首行 showDate
  });

  it('showDate 附加日期分隔；非首行不带日期', () => {
    const [i1, i2] = first([msg('m1'), msg('m2', { authorType: 'human', agentName: undefined, createdAt: iso(30) })]);
    expect(estimateStreamItemSize(i1)).toBe(E.date + E.agent);
    // 人类消息不参与前一条 agent 的合并（authorType 不同）→ 非 compact，同日无日期
    expect(estimateStreamItemSize(i2)).toBe(E.human);
  });

  it('连续合并 compact → compactDelta 扣减（同作者 5 分钟内）', () => {
    const [, i2] = first([msg('m1'), msg('m2', { createdAt: iso(1) })]);
    expect(i2.kind).toBe('message');
    if (i2.kind !== 'message') return;
    expect(i2.compact).toBe(true);
    expect(estimateStreamItemSize(i2)).toBe(E.agent + E.compactDelta);
  });

  it('人类气泡 → human 档；compact 人类气泡 → human + compactDelta', () => {
    const [i1, i2] = first([
      msg('h1', { authorType: 'human', agentName: undefined }),
      msg('h2', { authorType: 'human', agentName: undefined, createdAt: iso(1) }),
    ]);
    expect(estimateStreamItemSize(i1)).toBe(E.date + E.human); // 首行 showDate + 非 compact
    expect(estimateStreamItemSize(i2)).toBe(E.human + E.compactDelta);
  });

  it('系统播报（Studio 署名无卡）→ system 档', () => {
    const [item] = first([msg('s1', { agentName: 'Studio' })]);
    expect(estimateStreamItemSize(item)).toBe(E.date + E.system);
  });

  it('卡片消息 → card 档（cardType 优先于作者分型）', () => {
    const [item] = first([msg('c1', { meta: JSON.stringify({ cardType: 'wu_done' }) })]);
    expect(estimateStreamItemSize(item)).toBe(E.date + E.card);
  });

  it('degraded 骨架 → skeleton 档（content 已剥离，一律固定占位）', () => {
    const [item] = first([msg('d1', { degraded: true })]);
    expect(estimateStreamItemSize(item)).toBe(E.date + E.skeleton);
  });

  it('thread 折叠态 = anchor 档 + 回复 toggle；无回复不加 toggle', () => {
    const [t2] = threadView(2, { collapsedThreads: new Set(['a1']) }).items;
    expect(estimateStreamItemSize(t2)).toBe(E.date + E.agent + E.threadToggle);
    const solo = deriveStreamView([msg('a9', { workUnitId: 'wu-9' })], ui()).items[0];
    expect(estimateStreamItemSize(solo)).toBe(E.date + E.agent);
  });

  it('thread anchor 为卡片/系统播报时按对应档计（收起态 = anchor 档 + toggle）', () => {
    const [t] = deriveStreamView(
      [msg('a1', { workUnitId: 'wu-1', agentName: 'Studio' }), msg('r1', { replyToId: 'a1', createdAt: iso(1) })],
      ui({ collapsedThreads: new Set(['a1']) }),
    ).items;
    expect(estimateStreamItemSize(t)).toBe(E.date + E.system + E.threadToggle);
    const [tc] = deriveStreamView(
      [msg('a2', { workUnitId: 'wu-2', meta: JSON.stringify({ cardType: 'wu_done' }) }), msg('r2', { replyToId: 'a2', createdAt: iso(1) })],
      ui({ collapsedThreads: new Set(['a2']) }),
    ).items;
    expect(estimateStreamItemSize(tc)).toBe(E.date + E.card + E.threadToggle);
  });

  it('thread 展开态（默认）= anchor + 逐条回复（msg 按档、折叠过程组按按钮档）', () => {
    // 5 条连续 agent 回复：r1-r4 非里程碑折进 proc-group（折叠），r5 最后一条里程碑单列
    const [t] = threadView(5).items;
    if (t.kind !== 'thread') throw new Error('expected thread');
    expect(t.replies.map(r => r.kind)).toEqual(['proc-group', 'msg']);
    expect(estimateStreamItemSize(t)).toBe(E.date + E.agent + E.procGroupCollapsed + E.agent);
  });

  it('展开线程内的过程组再展开 = 组内消息逐条全量计（不省头）', () => {
    const view = threadView(5, { expandedProcGroups: new Set(['proc-r1']) });
    const [t] = view.items;
    if (t.kind !== 'thread') throw new Error('expected thread');
    expect(estimateStreamItemSize(t)).toBe(E.date + E.agent + 4 * E.agent + E.agent);
  });

  it('thread anchor degraded → skeleton 档（含日期）', () => {
    const [t] = deriveStreamView(
      [msg('a1', { workUnitId: 'wu-1', degraded: true }), msg('r1', { replyToId: 'a1', createdAt: iso(1) })],
      ui(),
    ).items;
    expect(estimateStreamItemSize(t)).toBe(E.date + E.skeleton);
  });
});
