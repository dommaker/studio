// freshIds（#549）：新内容进场渐隐高亮的核心机制唯一一份——
// id 集 + per-id 2s 自清计时。语义 per-id：各自到达起 2s 渐隐，互不重计时
// （替代频道消息侧旧「单 timer 全清」语义，与 WU 行侧原页面手写 per-id 语义合一）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFreshIdTracker, FRESH_FADE_MS } from '../freshIds';

describe('createFreshIdTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mark → onChange 收到含该 id 的集合快照', () => {
    const onChange = vi.fn();
    const tracker = createFreshIdTracker(onChange);
    tracker.mark('a');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect([...(onChange.mock.calls[0][0] as ReadonlySet<string>)]).toEqual(['a']);
    tracker.dispose();
  });

  it('per-id 自清：各自到达起 2s 渐隐，互不重计时', () => {
    let current: ReadonlySet<string> = new Set();
    const tracker = createFreshIdTracker(ids => { current = ids; });
    tracker.mark('a');
    vi.advanceTimersByTime(FRESH_FADE_MS - 1);
    tracker.mark('b');
    // a 到自己的 2s 即清（不受 b 到达影响），b 仍在集
    vi.advanceTimersByTime(1);
    expect(current.has('a')).toBe(false);
    expect(current.has('b')).toBe(true);
    vi.advanceTimersByTime(FRESH_FADE_MS);
    expect(current.size).toBe(0);
    tracker.dispose();
  });

  it('同 id 窗口内重复 mark：集合不重复通知（已在集），计时重置', () => {
    const onChange = vi.fn();
    const tracker = createFreshIdTracker(onChange);
    tracker.mark('a');
    vi.advanceTimersByTime(FRESH_FADE_MS - 1);
    tracker.mark('a');
    expect(onChange).toHaveBeenCalledTimes(1); // 重复 mark 不产生新快照
    vi.advanceTimersByTime(1);
    // 计时已重置：a 仍在集
    expect([...(onChange.mock.calls[0][0] as ReadonlySet<string>)]).toEqual(['a']);
    vi.advanceTimersByTime(FRESH_FADE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect((onChange.mock.calls[1][0] as ReadonlySet<string>).size).toBe(0);
    tracker.dispose();
  });

  it('dispose：清全部计时器，之后不再触发 onChange', () => {
    const onChange = vi.fn();
    const tracker = createFreshIdTracker(onChange);
    tracker.mark('a');
    tracker.mark('b');
    tracker.dispose();
    onChange.mockClear();
    vi.advanceTimersByTime(FRESH_FADE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
  });
});
