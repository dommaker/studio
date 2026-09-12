/**
 * #521（spec .studio/specs/2026-09-12-channel-mainline-measurement §2）：
 * 离线对齐工具纯函数测试——合成消息/WU/事件三份样本（含已知时间差），
 * 断言四段分布（派单/等认领/执行总时长/回执落库）与单链明细正确；
 * 缺失段样本如实标注跳过；时间窗过滤与按 traceId 单链查询可用。
 */
import { describe, it, expect } from 'vitest';
import {
  buildChains,
  filterChainsByWindow,
  summarizeChains,
  findChainsByTraceId,
  type ChannelMessageRow,
  type WorkUnitSnapshotRow,
  type StudioEventRow,
} from '../mainline-align-core.js';

const T0 = Date.parse('2026-09-12T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

// ── 合成样本：三条链路，时间差全已知 ──
// 链 A（完整四段）：消息落库 +2s 建单，+10s 认领，执行 60s（两步：+20s/+60s），回执 +3s 落库
// 链 B（缺回执）：+1s 建单，+5s 认领，执行 30s，无回执消息
// 链 C（未认领）：+4s 建单，无 claimedAt/completedAt
const msgADispatch: ChannelMessageRow = {
  id: 'msg-a', channelId: 'ch1', authorType: 'human', workUnitId: 'wu-a', createdAt: iso(0),
};
const msgAReceipt: ChannelMessageRow = {
  id: 'msg-a-receipt', channelId: 'ch1', authorType: 'agent', workUnitId: 'wu-a', createdAt: iso(2_000 + 10_000 + 60_000 + 3_000),
};
const msgBDispatch: ChannelMessageRow = {
  id: 'msg-b', channelId: 'ch1', authorType: 'human', workUnitId: 'wu-b', createdAt: iso(100_000),
};
const msgCDispatch: ChannelMessageRow = {
  id: 'msg-c', channelId: 'ch1', authorType: 'human', workUnitId: 'wu-c', createdAt: iso(200_000),
};
// 同 id 更新副本（linkWorkUnit 回填）：后行者胜出，createdAt 不变
const msgADispatchBackfill: ChannelMessageRow = {
  ...msgADispatch, workUnitId: 'wu-a',
};

const wuA: WorkUnitSnapshotRow = {
  id: 'wu-a', channelId: 'ch1', status: 'closed',
  createdAt: iso(2_000), claimedAt: iso(12_000), completedAt: iso(72_000),
  metadata: JSON.stringify({ traceId: 'trace-a', anchorMessageId: 'msg-a' }),
};
const wuB: WorkUnitSnapshotRow = {
  id: 'wu-b', channelId: 'ch1', status: 'closed',
  createdAt: iso(101_000), claimedAt: iso(106_000), completedAt: iso(136_000),
  metadata: JSON.stringify({ traceId: 'trace-b', anchorMessageId: 'msg-b' }),
};
const wuC: WorkUnitSnapshotRow = {
  id: 'wu-c', channelId: 'ch1', status: 'unassigned',
  createdAt: iso(204_000), claimedAt: null, completedAt: null,
  metadata: JSON.stringify({ traceId: 'trace-c', anchorMessageId: 'msg-c' }),
};

const stepEvents: StudioEventRow[] = [
  {
    type: 'workunit:execution_step',
    payload: JSON.stringify({ workUnitId: 'wu-a', executionId: 'exec-a', step: 1, status: 'success', at: iso(32_000) }),
    createdAt: iso(32_000),
  },
  {
    type: 'workunit:execution_step',
    payload: JSON.stringify({ workUnitId: 'wu-a', executionId: 'exec-a', step: 2, status: 'success', at: iso(72_000) }),
    createdAt: iso(72_000),
  },
  {
    type: 'workunit:execution_step',
    payload: JSON.stringify({ workUnitId: 'wu-b', executionId: 'exec-b', step: 1, status: 'failed', at: iso(136_000) }),
    createdAt: iso(136_000),
  },
  { type: 'client.perf.receipt_render', source: 'web-client', payload: JSON.stringify({ messageId: 'msg-a-receipt', workUnitId: 'wu-a', ms: 42 }), createdAt: iso(76_000) },
  { type: 'knowledge:distill', payload: JSON.stringify({ foo: 1 }), createdAt: iso(80_000) },
];

const baseInput = () => ({
  messages: [msgADispatch, msgAReceipt, msgBDispatch, msgCDispatch, msgADispatchBackfill],
  workunits: [wuA, wuB, wuC],
  events: stepEvents,
});

describe('buildChains', () => {
  it('对齐出四段已知时间差；步级分解正确', () => {
    const chains = buildChains(baseInput());
    expect(chains).toHaveLength(3);
    const a = chains.find(c => c.workUnitId === 'wu-a')!;
    expect(a.traceId).toBe('trace-a');
    expect(a.dispatchMessageId).toBe('msg-a');
    expect(a.dispatchMs).toBe(2_000);
    expect(a.waitClaimMs).toBe(10_000);
    expect(a.executionMs).toBe(60_000);
    expect(a.steps).toEqual([
      { step: 1, at: T0 + 32_000, deltaMs: 20_000, status: 'success' },
      { step: 2, at: T0 + 72_000, deltaMs: 40_000, status: 'success' },
    ]);
    expect(a.receiptMessageId).toBe('msg-a-receipt');
    expect(a.receiptMs).toBe(3_000);
    expect(a.skips).toEqual([]);
  });

  it('缺失段如实标注跳过，不静默丢样本', () => {
    const chains = buildChains(baseInput());
    const b = chains.find(c => c.workUnitId === 'wu-b')!;
    expect(b.dispatchMs).toBe(1_000);
    expect(b.waitClaimMs).toBe(5_000);
    expect(b.executionMs).toBe(30_000);
    expect(b.receiptMs).toBeNull();
    expect(b.skips).toContain('receipt:no_receipt_message');

    const c = chains.find(c => c.workUnitId === 'wu-c')!;
    expect(c.dispatchMs).toBe(4_000);
    expect(c.waitClaimMs).toBeNull();
    expect(c.executionMs).toBeNull();
    expect(c.receiptMs).toBeNull();
    expect(c.skips).toContain('waitClaim:no_claimedAt');
    expect(c.skips).toContain('execution:no_claimedAt');
    expect(c.skips).toContain('receipt:no_completedAt');
  });

  it('无 anchorMessageId 时回退到最早的人类派发消息；晚于建单的人类消息（合并窗口搭车）不算派发', () => {
    const mergedMsg: ChannelMessageRow = {
      id: 'msg-d-merge', channelId: 'ch1', authorType: 'human', workUnitId: 'wu-d', createdAt: iso(500_000),
    };
    const dispatchD: ChannelMessageRow = {
      id: 'msg-d', channelId: 'ch1', authorType: 'human', workUnitId: 'wu-d', createdAt: iso(400_000),
    };
    const wuD: WorkUnitSnapshotRow = {
      id: 'wu-d', channelId: 'ch1', status: 'active',
      createdAt: iso(403_000), claimedAt: iso(408_000), completedAt: null,
      metadata: JSON.stringify({ traceId: 'trace-d' }), // 无 anchorMessageId
    };
    const chains = buildChains({ messages: [mergedMsg, dispatchD], workunits: [wuD], events: [] });
    const d = chains.find(c => c.workUnitId === 'wu-d')!;
    expect(d.dispatchMessageId).toBe('msg-d');
    expect(d.dispatchMs).toBe(3_000);
  });

  it('找不到派发消息时派单段标注跳过', () => {
    const wuOrphan: WorkUnitSnapshotRow = {
      id: 'wu-orphan', channelId: 'ch9', status: 'closed',
      createdAt: iso(600_000), claimedAt: iso(601_000), completedAt: iso(602_000),
      metadata: JSON.stringify({ traceId: 'trace-o', anchorMessageId: 'msg-gone' }),
    };
    const chains = buildChains({ messages: [], workunits: [wuOrphan], events: [] });
    const o = chains[0];
    expect(o.dispatchMs).toBeNull();
    expect(o.skips).toContain('dispatch:no_dispatch_message');
    expect(o.waitClaimMs).toBe(1_000);
  });

  it('畸形 metadata / 缺失时间字段不抛错，相应段标注跳过', () => {
    const wuBad: WorkUnitSnapshotRow = {
      id: 'wu-bad', channelId: 'ch1', status: 'closed',
      createdAt: undefined, claimedAt: undefined, completedAt: undefined,
      metadata: '{not-json',
    };
    const chains = buildChains({ messages: [], workunits: [wuBad], events: [] });
    const bad = chains[0];
    expect(bad.traceId).toBeNull();
    expect(bad.dispatchMs).toBeNull();
    expect(bad.skips).toContain('dispatch:no_wu_createdAt');
    expect(bad.skips).toContain('waitClaim:no_wu_createdAt');
    expect(bad.skips).toContain('execution:no_claimedAt');
  });
});

describe('summarizeChains', () => {
  it('四段分布 p50/p95 正确；跳过原因计数', () => {
    const report = summarizeChains(buildChains(baseInput()));
    expect(report.chainCount).toBe(3);
    // 派单样本 [2000, 1000, 4000] → 排序 [1000, 2000, 4000]
    expect(report.segments.dispatch.n).toBe(3);
    expect(report.segments.dispatch.p50Ms).toBe(2_000);
    expect(report.segments.dispatch.p95Ms).toBe(4_000);
    // 等认领 [10000, 5000]（nearest-rank：偶数样本 p50 取下中位）；wu-c 缺 claimedAt 跳过
    expect(report.segments.waitClaim.n).toBe(2);
    expect(report.segments.waitClaim.p50Ms).toBe(5_000);
    expect(report.segments.waitClaim.skipped['waitClaim:no_claimedAt']).toBe(1);
    // 执行 [60000, 30000]
    expect(report.segments.execution.n).toBe(2);
    expect(report.segments.execution.p50Ms).toBe(30_000);
    expect(report.segments.execution.p95Ms).toBe(60_000);
    // 回执 [3000]；b 无回执消息、c 未完成各跳过
    expect(report.segments.receipt.n).toBe(1);
    expect(report.segments.receipt.p50Ms).toBe(3_000);
    expect(report.segments.receipt.skipped['receipt:no_receipt_message']).toBe(1);
    expect(report.segments.receipt.skipped['receipt:no_completedAt']).toBe(1);
  });

  it('client.perf 事件有样本出分布，无样本如实标注', () => {
    const report = summarizeChains(buildChains(baseInput()), baseInput().events);
    expect(report.clientPerf['client.perf.receipt_render'].n).toBe(1);
    expect(report.clientPerf['client.perf.receipt_render'].p50Ms).toBe(42);
    expect(report.clientPerf['client.perf.send_click'].n).toBe(0);
    expect(report.clientPerf['client.perf.send_click'].note).toBe('no_samples');

    const empty = summarizeChains(buildChains(baseInput()), []);
    expect(empty.clientPerf['client.perf.receipt_render'].n).toBe(0);
    expect(empty.clientPerf['client.perf.receipt_render'].note).toBe('no_samples');
  });
});

describe('filterChainsByWindow', () => {
  it('按 WU 建成时间过滤', () => {
    const chains = buildChains(baseInput());
    const win = filterChainsByWindow(chains, { sinceMs: T0 + 50_000, untilMs: T0 + 150_000 });
    expect(win.map(c => c.workUnitId)).toEqual(['wu-b']);
    const sinceOnly = filterChainsByWindow(chains, { sinceMs: T0 + 150_000 });
    expect(sinceOnly.map(c => c.workUnitId)).toEqual(['wu-c']);
    const all = filterChainsByWindow(chains, {});
    expect(all).toHaveLength(3);
  });
});

describe('findChainsByTraceId', () => {
  it('按 traceId 查单链明细（含消息与步）', () => {
    const chains = buildChains(baseInput());
    const hits = findChainsByTraceId(chains, 'trace-a');
    expect(hits).toHaveLength(1);
    expect(hits[0].workUnitId).toBe('wu-a');
    expect(hits[0].steps).toHaveLength(2);
    expect(findChainsByTraceId(chains, 'trace-nonexistent')).toEqual([]);
  });
});
