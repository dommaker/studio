// 频道消息流虚拟化纯函数（#325，ADR 2026-08-24 channel-stream-virtualization）：
// key 稳定性、mid→item 索引映射、prepend 锚点补偿数学、末行钉底判定。
// jsdom 无布局不可测 virtualizer 本体，行为拆纯函数在此单测；hook/组件侧只负责接线。
import { describe, it, expect } from 'vitest';
import {
  STREAM_VIRTUAL_ENABLED,
  streamItemKey,
  buildMessageToItemIndex,
  anchorScrollTopAfterPrepend,
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
  expandedThreads: new Set(),
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

  it('thread 折叠态：anchor id → thread index；折叠 replies 不在视图模型中，不入映射（与虚拟化前 DOM 查询行为对齐）', () => {
    const map = buildMessageToItemIndex(threadView(3).items);
    expect(map.get('a1')).toBe(0);
    // 折叠态 replies 未渲染（deriveStreamView 不计算），锚点捕获/恢复本就不可能命中——维持现状兜底语义
    expect(map.get('r1')).toBeUndefined();
    expect(map.get('r3')).toBeUndefined();
  });

  it('thread 展开 + 过程组折叠：组内消息 id 同样映射到 thread index', () => {
    // 5 条 agent 回复连续非里程碑 → 前几条折进 proc-group（里程碑含最后一条）
    const view = threadView(5, { expandedThreads: new Set(['a1']) });
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
