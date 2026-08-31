// fetchDiscipline 单测 — #403 取数纪律底座（ADR 2026-08-31 决策 6）的契约钉子。
// rosterStore / channelDataStore 迁移其上，此文件直接锁定纪律语义：
// TTL 免拉 / single-flight 并入 / force 不并入在途 / bypassTtl 只跳 TTL / seq 守卫 / inflight 只清自己。
import { describe, it, expect, vi } from 'vitest';
import { createFetchGate, disciplinedFetch, type FetchGateState } from '../fetchDiscipline';

function harness(initial?: Partial<FetchGateState>) {
  const gate = createFetchGate();
  const state: FetchGateState = { loadedAt: null, inflight: null, ...initial };
  const ops = {
    read: () => ({ ...state }),
    setInflight: (p: Promise<void> | null) => { state.inflight = p; },
  };
  return { gate, ops, state };
}

describe('disciplinedFetch — TTL / single-flight / seq 纪律', () => {
  it('loadedAt 为 null → 发起拉取（body 收到 seq，loadedAt 由 body 自落）', async () => {
    const { gate, ops } = harness();
    const seen: number[] = [];
    await disciplinedFetch(gate, ops, { maxAgeMs: 30000 }, async (seq) => { seen.push(seq); });
    expect(seen).toHaveLength(1);
  });

  it('TTL 内免拉：loadedAt 新鲜 → resolved，body 不执行', async () => {
    vi.useFakeTimers();
    try {
      const { gate, ops } = harness({ loadedAt: Date.now() });
      const body = vi.fn();
      await disciplinedFetch(gate, ops, { maxAgeMs: 30000 }, body);
      expect(body).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTL 过期重拉；maxAgeMs 0（force）TTL 内也重拉', async () => {
    vi.useFakeTimers();
    try {
      const { gate, ops } = harness({ loadedAt: Date.now() });
      const body = vi.fn();
      vi.advanceTimersByTime(30001);
      await disciplinedFetch(gate, ops, { maxAgeMs: 30000 }, body);
      expect(body).toHaveBeenCalledTimes(1);
      await disciplinedFetch(gate, ops, { maxAgeMs: 0 }, body);
      expect(body).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('single-flight：在途时并入（返回同一 Promise）；force（maxAgeMs 0）不并入', async () => {
    const { gate, ops } = harness();
    let resolveFirst!: () => void;
    const first = disciplinedFetch(gate, ops, { maxAgeMs: 30000 }, () => new Promise<void>((r) => { resolveFirst = r; }));
    const joined = disciplinedFetch(gate, ops, { maxAgeMs: 30000 }, () => {
      throw new Error('joined call must not start a new body');
    });
    expect(joined).toBe(first);
    const forced = disciplinedFetch(gate, ops, { maxAgeMs: 0 }, async () => {});
    expect(forced).not.toBe(first);
    resolveFirst();
    await Promise.all([first, joined, forced]);
  });

  it('bypassTtl：TTL 内仍发起（idle 时）；在途时仍并入 single-flight（rosterStore 换号语义）', async () => {
    vi.useFakeTimers();
    try {
      // idle + TTL 新鲜：bypassTtl 发起（对照：无 bypass 免拉）
      const { gate, ops } = harness({ loadedAt: Date.now() });
      const body = vi.fn();
      await disciplinedFetch(gate, ops, { maxAgeMs: 30000 }, body);
      expect(body).not.toHaveBeenCalled();
      await disciplinedFetch(gate, ops, { maxAgeMs: 30000, bypassTtl: true }, body);
      expect(body).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    // 在途：bypassTtl 仍并入（不新起 body）
    const fresh = harness();
    let resolveFirst!: () => void;
    const first = disciplinedFetch(fresh.gate, fresh.ops, { maxAgeMs: 30000 }, () => new Promise<void>((r) => { resolveFirst = r; }));
    const bypassed = disciplinedFetch(fresh.gate, fresh.ops, { maxAgeMs: 30000, bypassTtl: true }, () => {
      throw new Error('bypassTtl must still join in-flight');
    });
    expect(bypassed).toBe(first);
    resolveFirst();
    await Promise.all([first, bypassed]);
  });

  it('seq 守卫：被超越的旧 fetch 结算不落库、不清新 fetch 的 inflight 锚点', async () => {
    const { gate, ops } = harness();
    let releaseStale!: () => void;
    let staleSeq = -1;
    const stale = disciplinedFetch(gate, ops, { maxAgeMs: 30000 }, async (seq) => {
      staleSeq = seq;
      await new Promise<void>((r) => { releaseStale = r; });
    });
    // stale 在途时强拉（force 不并入）：先结算，结果落地
    const forced = disciplinedFetch(gate, ops, { maxAgeMs: 0 }, async () => {});
    await forced;
    expect(gate.isLatest(staleSeq)).toBe(false);
    expect(ops.read().inflight).toBeNull();
    // 第三次拉取在途（可控行为防微任务内提前结算）；旧 fetch 此刻晚到结算 → 不得清掉第三次的锚点
    let releaseThird!: () => void;
    const third = disciplinedFetch(gate, ops, { maxAgeMs: 30000 }, () => new Promise<void>((r) => { releaseThird = r; }));
    expect(ops.read().inflight).toBe(third);
    releaseStale();
    await stale;
    expect(ops.read().inflight).toBe(third);
    releaseThird();
    await third;
    expect(ops.read().inflight).toBeNull();
  });

  it('body 同步抛错 → 转为 rejected promise（调用方永不 reject 契约归 body 自理）', async () => {
    const { gate, ops } = harness();
    await expect(
      disciplinedFetch(gate, ops, { maxAgeMs: 30000 }, () => { throw new Error('sync boom'); }),
    ).rejects.toThrow('sync boom');
    expect(ops.read().inflight).toBeNull();
  });
});
