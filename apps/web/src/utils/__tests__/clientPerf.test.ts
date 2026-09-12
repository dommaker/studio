// #520（spec 2026-09-12-channel-mainline-measurement §3/§4）：clientPerf sink 单测——
// 三埋点的事件名/负载字段/触发时机（mark→emit 配对）、默认 HTTP sink 落既有事件端点、
// 关闭时零行为变化、sink 异常不外泄。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApiPost } = vi.hoisted(() => ({ mockApiPost: vi.fn() }));

vi.mock('../../api', () => ({ api: { post: mockApiPost } }));

import {
  setClientPerfSink,
  resetClientPerfSink,
  createHttpSink,
  emitSendClick,
  markReceiptArrived,
  emitReceiptRendered,
  markPageEntry,
  emitPageFirstRender,
  type ClientPerfEventType,
  type ClientPerfPayload,
} from '../clientPerf';

type Call = { type: ClientPerfEventType; payload: ClientPerfPayload };

function collectSink() {
  const calls: Call[] = [];
  setClientPerfSink((type, payload) => { calls.push({ type, payload }); });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClientPerfSink();
});

describe('clientPerf 三埋点（事件名/负载字段/时机）', () => {
  it('① emitSendClick 发 client.perf.send_click，负载带 channelId/replyToId', () => {
    const calls = collectSink();
    emitSendClick({ channelId: 'ch-1', replyToId: null });
    emitSendClick({ channelId: 'ch-1', replyToId: 'm-9' });
    expect(calls).toEqual([
      { type: 'client.perf.send_click', payload: { channelId: 'ch-1', replyToId: null } },
      { type: 'client.perf.send_click', payload: { channelId: 'ch-1', replyToId: 'm-9' } },
    ]);
  });

  it('② SSE 到达标记 → 渲染完成发 client.perf.receipt_render（含耗时与关联字段）', () => {
    const calls = collectSink();
    markReceiptArrived('m-1');
    emitReceiptRendered({ messageId: 'm-1', channelId: 'ch-1', workUnitId: 'WU-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('client.perf.receipt_render');
    expect(calls[0].payload.channelId).toBe('ch-1');
    expect(calls[0].payload.messageId).toBe('m-1');
    expect(calls[0].payload.workUnitId).toBe('WU-1');
    expect(typeof calls[0].payload.ms).toBe('number');
    expect(calls[0].payload.ms!).toBeGreaterThanOrEqual(0);
  });

  it('② 未标记的消息渲染不发事件；标记消费后同一条不重发', () => {
    const calls = collectSink();
    emitReceiptRendered({ messageId: 'm-x', channelId: 'ch-1', workUnitId: null });
    expect(calls).toHaveLength(0);

    markReceiptArrived('m-1');
    emitReceiptRendered({ messageId: 'm-1', channelId: 'ch-1', workUnitId: null });
    emitReceiptRendered({ messageId: 'm-1', channelId: 'ch-1', workUnitId: null });
    expect(calls).toHaveLength(1);
  });

  it('③ 进页标记 → 首屏消息渲染完成发 client.perf.page_load（含耗时），每进页至多一次', () => {
    const calls = collectSink();
    emitPageFirstRender('ch-1'); // 未进页标记 → 不发
    expect(calls).toHaveLength(0);

    markPageEntry('ch-1');
    emitPageFirstRender('ch-1');
    emitPageFirstRender('ch-1'); // 起点已消费 → 不重发
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('client.perf.page_load');
    expect(calls[0].payload.channelId).toBe('ch-1');
    expect(typeof calls[0].payload.ms).toBe('number');
  });
});

describe('clientPerf sink 关闭（零行为变化）', () => {
  it('sink=null 时三埋点全部 no-op 且不抛', () => {
    setClientPerfSink(null);
    expect(() => {
      emitSendClick({ channelId: 'ch-1', replyToId: null });
      markReceiptArrived('m-1');
      emitReceiptRendered({ messageId: 'm-1', channelId: 'ch-1', workUnitId: null });
      markPageEntry('ch-1');
      emitPageFirstRender('ch-1');
    }).not.toThrow();
  });

  it('关闭期间的标记不留存——重新开启后补渲染不发事件', () => {
    setClientPerfSink(null);
    markReceiptArrived('m-1');
    markPageEntry('ch-1');
    const calls = collectSink(); // 重新装配
    emitReceiptRendered({ messageId: 'm-1', channelId: 'ch-1', workUnitId: null });
    emitPageFirstRender('ch-1');
    expect(calls).toHaveLength(0);
  });
});

describe('clientPerf 异常不外泄', () => {
  it('sink 抛异常被 safeEmit 吞掉', () => {
    setClientPerfSink(() => { throw new Error('boom'); });
    expect(() => {
      emitSendClick({ channelId: 'ch-1', replyToId: null });
      markReceiptArrived('m-1');
      emitReceiptRendered({ messageId: 'm-1', channelId: 'ch-1', workUnitId: null });
    }).not.toThrow();
  });
});

describe('clientPerf 默认 HTTP sink（经既有 POST /api/v1/events 落事件流）', () => {
  it('createHttpSink 按端点契约 POST {type, source, payload}', () => {
    mockApiPost.mockResolvedValue({ status: 201 });
    setClientPerfSink(createHttpSink());
    emitSendClick({ channelId: 'ch-1', replyToId: null });
    expect(mockApiPost).toHaveBeenCalledWith('/events', {
      type: 'client.perf.send_click',
      source: 'web-client',
      payload: { channelId: 'ch-1', replyToId: null },
    });
  });

  it('端点失败静默（reject 不外泄）', async () => {
    mockApiPost.mockRejectedValue(new Error('network down'));
    setClientPerfSink(createHttpSink());
    expect(() => emitSendClick({ channelId: 'ch-1', replyToId: null })).not.toThrow();
    // 让 reject 链跑完，断言无 unhandled rejection 打断测试
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
