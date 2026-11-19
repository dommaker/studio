// api/sseParser.ts 单点校验锚定测试（#690）：sseEventSchema 接到 onmessage 单点解析
// （parseSseMessage）——词表内事件校验后广播（isSseEvent narrow 取型），畸形负载可见 log + 丢弃，
// 词表外事件 loose 信封透传。
import { describe, it, expect, vi } from 'vitest';
import { parseSseMessage, isSseEvent } from '../sseParser';

describe('parseSseMessage（onmessage 单点校验，#690）', () => {
  it('词表内合法事件 → 已校验 SseEvent，isSseEvent narrow 后 data = 具名 payload 类型', () => {
    const msg = parseSseMessage({
      event_id: 'e-1',
      event_type: 'workunit:removed',
      timestamp: '2026-10-09T00:00:00Z',
      data: { id: 'wu-1', channelId: null },
    });
    expect(msg?.event_type).toBe('workunit:removed');
    if (!msg || !isSseEvent(msg, 'workunit:removed')) throw new Error('应 narrow 为 workunit:removed');
    // 类型层断言：narrow 后 data 是 WorkunitRemovedPayload（非 unknown，无需强转）
    const id: string = msg.data.id;
    const channelId: string | null = msg.data.channelId;
    expect(id).toBe('wu-1');
    expect(channelId).toBeNull();
  });

  it('knowledge.entry_changed 无 event_id 合法（发射点不带）', () => {
    const msg = parseSseMessage({
      event_type: 'knowledge.entry_changed',
      timestamp: '2026-10-09T00:00:00Z',
      data: { action: 'created', entryId: 'e2' },
    });
    expect(msg?.event_type).toBe('knowledge.entry_changed');
  });

  it('词表内畸形负载 → console.warn 可见（不静默）+ 返回 null（丢弃不广播进 store）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const msg = parseSseMessage({
        event_type: 'workunit:removed',
        timestamp: '2026-10-09T00:00:00Z',
        data: { channelId: 'ch-1' }, // 缺 id
      });
      expect(msg).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain('workunit:removed');
    } finally {
      warn.mockRestore();
    }
  });

  it('词表外事件 → loose 信封原样透传（runtime.* 遗留 / knowledge 桥 payload 键）', () => {
    const bridged = parseSseMessage({ event_type: 'knowledge.doc_changed', payload: { id: 'd1' } });
    expect(bridged).toMatchObject({ event_type: 'knowledge.doc_changed', payload: { id: 'd1' } });
    const legacy = parseSseMessage({ event_type: 'runtime.legacy', data: { x: 1 } });
    expect(legacy?.event_type).toBe('runtime.legacy');
  });

  it('connection.established 裸帧 / 非信封垃圾 → null（无消费方，静默丢弃）', () => {
    expect(parseSseMessage({ clientId: 'c1', topics: [] })).toBeNull();
    expect(parseSseMessage(42)).toBeNull();
    expect(parseSseMessage(null)).toBeNull();
  });
});

describe('isSseEvent（消费点 narrow 谓词）', () => {
  it('event_type 命中/未命中；多类型合并 narrow', () => {
    const msg = parseSseMessage({
      event_type: 'notification.created',
      timestamp: '2026-10-09T00:00:00Z',
      data: { title: 't', content: 'c', wuId: 'WU-1', link: '/x' },
    });
    if (!msg) throw new Error('应解析成功');
    expect(isSseEvent(msg, 'notification.created')).toBe(true);
    expect(isSseEvent(msg, 'workunit.created', 'workunit.status_changed')).toBe(false);
    if (isSseEvent(msg, 'workunit.created', 'notification.created')) {
      // 联合 narrow：两分支 data 类型不同，此处命中的应是 notification.created
      if (msg.event_type === 'notification.created') expect(msg.data.wuId).toBe('WU-1');
    } else {
      throw new Error('多类型 narrow 应命中');
    }
  });
});
