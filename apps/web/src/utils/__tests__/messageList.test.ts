// messageList 纯函数（#548 自 useChannelEvents 抽取）：
// insertMessage — createdAt 升序归位 + id 去重（#287：下游 groupIntoThreads 单遍归组
// 要求 anchor 先于 reply）；mergePage — refetch 合并（#328：已存在按服务端版本刷新、
// 新消息有序插入、prepend 的历史页原样保留）。
import { describe, it, expect } from 'vitest';
import type { ChannelMessage } from '../../api/channel';
import { insertMessage, mergePage } from '../messageList';

const iso = (s: number) => new Date(s * 1000).toISOString();

function msg(id: string, seq: number, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id,
    channelId: 'ch-1',
    authorType: 'agent',
    content: `内容-${id}`,
    replyToId: null,
    createdAt: iso(seq),
    ...over,
  };
}

describe('insertMessage', () => {
  it('尾部追加：createdAt 最新时插到末尾', () => {
    const prev = [msg('m1', 0), msg('m2', 1)];
    expect(insertMessage(prev, msg('m3', 2)).map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('乱序到达按 createdAt 归位，不盲推尾部', () => {
    const prev = [msg('m1', 0), msg('m3', 2)];
    expect(insertMessage(prev, msg('m2', 1)).map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('插到最前：createdAt 早于全部现有消息', () => {
    const prev = [msg('m2', 1), msg('m3', 2)];
    expect(insertMessage(prev, msg('m1', 0)).map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('id 已存在 → 原样返回（引用不变，SSE 回声不重复）', () => {
    const prev = [msg('m1', 0)];
    const next = insertMessage(prev, msg('m1', 0, { content: '回声' }));
    expect(next).toBe(prev);
  });

  it('空列表插入单条', () => {
    expect(insertMessage([], msg('m1', 0)).map(m => m.id)).toEqual(['m1']);
  });
});

describe('mergePage', () => {
  it('已存在的消息以服务端版本刷新（原位替换）', () => {
    const prev = [msg('m1', 0), msg('m2', 1)];
    const updated = msg('m2', 1, { content: '服务端更新' });
    const next = mergePage(prev, [updated]);
    expect(next.map(m => m.id)).toEqual(['m1', 'm2']);
    expect(next[1].content).toBe('服务端更新');
  });

  it('新消息按 createdAt 有序插入（归并进现有列表）', () => {
    const prev = [msg('m1', 0), msg('m3', 2)];
    const next = mergePage(prev, [msg('m2', 1), msg('m4', 3)]);
    expect(next.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('prepend 的历史页原样保留（页内不含的旧消息不动）', () => {
    const prev = [msg('m0', -1), msg('m1', 0)];
    const next = mergePage(prev, [msg('m1', 0, { content: '刷新' }), msg('m2', 1)]);
    expect(next.map(m => m.id)).toEqual(['m0', 'm1', 'm2']);
    expect(next[0].content).toBe('内容-m0');
  });

  it('空页 = 无操作（内容与 id 序列不变）', () => {
    const prev = [msg('m1', 0), msg('m2', 1)];
    expect(mergePage(prev, []).map(m => m.id)).toEqual(['m1', 'm2']);
  });
});
