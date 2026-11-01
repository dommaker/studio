import { describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../../api/channel';
import {
  createStreamViewDerivation,
  deriveStreamView,
  type StreamUiState,
} from '../streamView';

const t0 = new Date('2026-10-01T10:00:00.000Z').getTime();
const iso = (offsetMin: number) => new Date(t0 + offsetMin * 60000).toISOString();
const msg = (id: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id, channelId: 'ch-1', authorType: 'agent', agentName: 'pm', content: `内容-${id}`,
  replyToId: null, workUnitId: null, meta: {}, createdAt: iso(0), ...over,
});
const ui = (): StreamUiState => ({
  showCompleted: false,
  collapsedThreads: new Set(),
  expandedProcGroups: new Set(),
  expandedAlertGroups: new Set(),
  promotedQuestionIds: new Set(),
  isWaitingForInput: () => false,
});

describe('StreamViewDerivation — PERF-06 局部派生', () => {
  it('尾部 append 只修补受影响线程与相邻项，结果与全量派生一致', () => {
    const initial = [
      msg('a', { workUnitId: 'WU-1', createdAt: iso(0) }),
      msg('r1', { replyToId: 'a', createdAt: iso(1) }),
      msg('b', { createdAt: iso(2) }),
    ];
    const state = ui();
    const derivation = createStreamViewDerivation(initial, state);
    const untouched = derivation.view.items[1];
    const baselineReads = derivation.stats.derivedMessages;
    const next = [...initial, msg('r2', { replyToId: 'a', createdAt: iso(3) })];
    const started = performance.now();
    const view = derivation.append(next, state, 'r2');
    const interactionMs = performance.now() - started;

    expect(view).toEqual(deriveStreamView(next, state));
    expect(view.items[1]).toBe(untouched);
    expect(derivation.stats.fullDerives).toBe(1);
    expect(derivation.stats.patchCount).toBe(1);
    expect(derivation.stats.derivedMessages - baselineReads).toBeLessThanOrEqual(4);
    // §10.2 交互指标：记录真实 append→view 可用耗时；硬预算由 PERF-07 统一。
    console.info('[PERF-06] append interaction', { interactionMs, longTasks: 'not supported in jsdom', droppedFrames: 'not supported in jsdom' });
    expect(Number.isFinite(interactionMs)).toBe(true);
    expect(interactionMs).toBeGreaterThanOrEqual(0);
  });

  it('单条 update 不全量 derive，保留无关线程引用并更新相邻 compact', () => {
    const initial = [
      msg('a', { createdAt: iso(0) }),
      msg('b', { createdAt: iso(1) }),
      msg('t', { workUnitId: 'WU-1', createdAt: iso(2) }),
      msg('r', { replyToId: 't', createdAt: iso(3) }),
    ];
    const state = ui();
    const derivation = createStreamViewDerivation(initial, state);
    const oldThread = derivation.view.items[2];
    const baselineReads = derivation.stats.derivedMessages;
    const next = [...initial];
    next[1] = { ...next[1], content: '更新', createdAt: iso(10) };
    // createdAt 不可变；恢复合法 fixture 后仅内容变化。
    next[1] = { ...next[1], createdAt: initial[1].createdAt };
    const view = derivation.update(next, state, 'b');

    expect(view).toEqual(deriveStreamView(next, state));
    expect(view.items[2]).toBe(oldThread);
    expect(derivation.stats.fullDerives).toBe(1);
    expect(derivation.stats.patchCount).toBe(1);
    expect(derivation.stats.derivedMessages - baselineReads).toBeLessThanOrEqual(3);
  });

  it('连续 100 次 append 的派生读取量不随历史总长增长', () => {
    let messages = Array.from({ length: 2000 }, (_, i) => msg(`m${i}`, { createdAt: iso(i) }));
    const state = ui({ showCompleted: true });
    const derivation = createStreamViewDerivation(messages, state);
    const baselineReads = derivation.stats.derivedMessages;
    for (let i = 0; i < 100; i++) {
      const id = `new-${i}`;
      messages = [...messages, msg(id, { createdAt: iso(3000 + i) })];
      derivation.append(messages, state, id);
    }
    expect(derivation.stats.fullDerives).toBe(1);
    expect(derivation.stats.patchCount).toBe(100);
    expect(derivation.stats.derivedMessages - baselineReads).toBeLessThanOrEqual(300);
    expect(derivation.view).toEqual(deriveStreamView(messages, state));
  });

  it('append/update 的索引写入不随历史总长增长', () => {
    let messages = Array.from({ length: 2000 }, (_, i) => msg(`m${i}`, { createdAt: iso(i) }));
    const state = ui({ showCompleted: true });
    const derivation = createStreamViewDerivation(messages, state);
    const setSpy = vi.spyOn(Map.prototype, 'set');
    try {
      setSpy.mockClear();
      for (let i = 0; i < 100; i++) {
        const id = `indexed-${i}`;
        messages = [...messages, msg(id, { createdAt: iso(3000 + i) })];
        derivation.append(messages, state, id);
      }
      messages = [...messages];
      messages[100] = { ...messages[100], content: '局部更新' };
      derivation.update(messages, state, 'm100');
      console.info('[PERF-06] index writes after 100 appends + 1 update', setSpy.mock.calls.length);
      expect(setSpy.mock.calls.length).toBeLessThan(1000);
      expect(derivation.view).toEqual(deriveStreamView(messages, state));
    } finally {
      setSpy.mockRestore();
    }
  });

  it('常用 patch 稳定根数组并以 revision 通知，根复制量不随历史增长', () => {
    let messages = Array.from({ length: 2000 }, (_, i) => msg(`m${i}`, { createdAt: iso(i) }));
    const state = ui({ showCompleted: true });
    const derivation = createStreamViewDerivation(messages, state);
    const view = derivation.view;
    const items = view.items;
    const baseItems = (derivation as unknown as { baseItems: unknown[] }).baseItems;
    const sliceSpy = vi.spyOn(items, 'slice');
    const spliceSpy = vi.spyOn(baseItems, 'splice');
    try {
      for (let i = 0; i < 100; i++) {
        const id = `stable-${i}`;
        messages = [...messages, msg(id, { createdAt: iso(3000 + i) })];
        derivation.append(messages, state, id);
      }
      messages = [...messages];
      messages[50] = { ...messages[50], content: '局部更新' };
      derivation.update(messages, state, 'm50');
      const copiedItems = sliceSpy.mock.results.reduce((sum, result) => sum + (Array.isArray(result.value) ? result.value.length : 0), 0);
      console.info('[PERF-06] stable root patch copies', { copiedItems, spliceCalls: spliceSpy.mock.calls.length, revision: view.revision });
      expect(derivation.view).toBe(view);
      expect(view.items).toBe(items);
      expect(view.revision).toBe(102);
      expect(copiedItems).toBeLessThan(1000);
      expect(spliceSpy).not.toHaveBeenCalled();
      expect(view).toEqual(deriveStreamView(messages, state));
    } finally {
      sliceSpy.mockRestore();
      spliceSpy.mockRestore();
    }
  });

  it('告警 append 只重折连续告警段，完成态 update 同步淘汰较旧完成项', () => {
    const state = ui();
    let messages = [
      msg('c1', { meta: { status: 'done' }, createdAt: iso(0) }),
      msg('c2', { meta: { status: 'done' }, createdAt: iso(1) }),
      msg('a1', { agentName: 'Studio', content: '[WARNING] 一', createdAt: iso(2) }),
      msg('a2', { agentName: 'Studio', content: '[CRITICAL] 二', createdAt: iso(3) }),
    ];
    const derivation = createStreamViewDerivation(messages, state);
    messages = [...messages, msg('a3', { agentName: 'Studio', content: '[WARNING] 三', createdAt: iso(4) })];
    derivation.append(messages, state, 'a3');
    expect(derivation.view).toEqual(deriveStreamView(messages, state));

    const next = [...messages];
    next.push(msg('c3', { meta: { status: 'done' }, createdAt: iso(5) }));
    derivation.append(next, state, 'c3');
    expect(derivation.view).toEqual(deriveStreamView(next, state));
    expect(derivation.stats.fullDerives).toBe(3); // 告警成组与完成态可见性均属明确 structural rebuild
  });

  it('旧活跃消息后来完成/回退：保留项始终按消息顺序而非事件顺序', () => {
    const state = ui();
    const initial = [
      msg('old-active', { createdAt: iso(0) }),
      msg('done-new-1', { meta: { status: 'done' }, createdAt: iso(1) }),
      msg('done-new-2', { meta: { status: 'done' }, createdAt: iso(2) }),
    ];
    const derivation = createStreamViewDerivation(initial, state);
    const completed = [...initial];
    completed[0] = { ...completed[0], meta: { status: 'done' } };
    derivation.update(completed, state, 'old-active');
    expect(derivation.view).toEqual(deriveStreamView(completed, state));

    const reverted = [...completed];
    reverted[0] = { ...reverted[0], meta: {} };
    derivation.update(reverted, state, 'old-active');
    expect(derivation.view).toEqual(deriveStreamView(reverted, state));
  });

  it('多层回复 append 保持根线程归组与相邻日期/compact 语义', () => {
    const state = ui();
    const initial = [
      msg('root', { createdAt: iso(0) }),
      msg('mid', { replyToId: 'root', createdAt: iso(1) }),
      msg('other', { createdAt: iso(2) }),
    ];
    const derivation = createStreamViewDerivation(initial, state);
    const next = [...initial, msg('leaf', { replyToId: 'mid', createdAt: iso(3) })];
    const view = derivation.append(next, state, 'leaf');
    expect(view).toEqual(deriveStreamView(next, state));
    expect(view.items[1]).toBe(derivation.view.items[1]);
    expect(derivation.stats.fullDerives).toBe(1);
  });
});
