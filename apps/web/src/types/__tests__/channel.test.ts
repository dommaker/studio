// types/channel.ts — ChannelMessage 锚定测试（P3-a）：
// 本地标记可用 + api/channel.ts re-export 同一性（类型层由 tsc 锁，运行层锁契约字段不被本地标记覆盖）。
import { describe, it, expect } from 'vitest';
import type { ChannelMessage } from '../channel';
import type { ChannelMessage as ChannelMessageFromApi } from '../../api/channel';

describe('types/channel（ChannelMessage）', () => {
  it('契约 wire 字段 + 本地标记（degraded/pending）共存', () => {
    const msg = {
      id: 'm-1',
      channelId: 'ch-1',
      content: 'hi',
      degraded: true,
      pending: false,
    } as unknown as ChannelMessage;
    expect(msg.degraded).toBe(true);
    expect(msg.pending).toBe(false);
    expect(msg.id).toBe('m-1');
  });

  it('api/channel.ts re-export 同一性（同一名称两路径互赋值编译通过）', () => {
    const a = { id: 'm-1', pending: true } as unknown as ChannelMessage;
    const b: ChannelMessageFromApi = a;
    const c: ChannelMessage = b;
    expect(c.pending).toBe(true);
  });
});
