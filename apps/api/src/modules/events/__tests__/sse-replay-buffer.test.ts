/**
 * #491：SSE 短窗口内存 replay buffer 单测
 *  - seq 单调递增（SSE id 行来源，重连 Last-Event-ID 游标）
 *  - 环形容量：超限淘汰最老
 *  - replay 语义：窗口内按序补发 / 有洞返回 null 不补发 / 无法解析当新连接
 */
import { describe, it, expect } from 'vitest';
import { SseReplayBuffer } from '../sse-replay-buffer.js';

describe('SseReplayBuffer', () => {
  it('push 分配的 seq 从 1 开始单调递增', () => {
    const buf = new SseReplayBuffer(10);
    expect(buf.push('channels', 'channel.message_created', { id: 'm1' })).toBe(1);
    expect(buf.push('channels', 'channel.message_updated', { id: 'm1' })).toBe(2);
    expect(buf.push('tasks', 'task.updated', { id: 't1' })).toBe(3);
    expect(buf.currentSeq).toBe(3);
    expect(buf.size).toBe(3);
  });

  it('容量超限淘汰最老事件（环形）', () => {
    const buf = new SseReplayBuffer(3);
    for (let i = 0; i < 5; i++) buf.push('all', 'task.updated', { i });
    expect(buf.size).toBe(3);
    expect(buf.oldestSeq).toBe(3); // seq 1/2 已淘汰
    expect(buf.currentSeq).toBe(5);
  });

  it('replay：lastEventId 之后的事件按 seq 升序返回（含 message_updated 类）', () => {
    const buf = new SseReplayBuffer(10);
    buf.push('channels', 'channel.message_created', { id: 'm1' });
    buf.push('channels', 'channel.message_updated', { id: 'm1' });
    buf.push('channels', 'channel.message_created', { id: 'm2' });
    const entries = buf.replay('1');
    expect(entries).not.toBeNull();
    expect(entries!.map(e => e.seq)).toEqual([2, 3]);
    expect(entries!.map(e => e.eventType)).toEqual(['channel.message_updated', 'channel.message_created']);
  });

  it('replay：lastEventId 不落后（等于或晚于最新 seq）→ 空数组', () => {
    const buf = new SseReplayBuffer(10);
    buf.push('all', 'task.updated', {});
    expect(buf.replay('1')).toEqual([]);
    expect(buf.replay('999')).toEqual([]);
  });

  it('replay：lastEventId 无法解析（空串 / 旧版 uuid）→ 空数组，当新连接处理', () => {
    const buf = new SseReplayBuffer(10);
    buf.push('all', 'task.updated', {});
    expect(buf.replay('')).toEqual([]);
    expect(buf.replay('a1b2c3d4-e5f6-uuid')).toEqual([]);
  });

  it('replay：lastEventId 早于 buffer 最老事件（有洞）→ null 不补发；恰好贴边则全覆盖', () => {
    const buf = new SseReplayBuffer(3);
    for (let i = 0; i < 5; i++) buf.push('all', 'task.updated', { i });
    // 最老 seq=3：since=1 → 洞（seq2 已淘汰）；since=2 → 恰好覆盖
    expect(buf.replay('1')).toBeNull();
    const edge = buf.replay('2');
    expect(edge).not.toBeNull();
    expect(edge!.map(e => e.seq)).toEqual([3, 4, 5]);
  });

  it('replay：空 buffer 任何游标都不补发', () => {
    const buf = new SseReplayBuffer(10);
    expect(buf.replay('0')).toEqual([]);
    expect(buf.replay('5')).toEqual([]);
  });
});
