// #416 消息摘要投影 hook：全量消息 → 右栏消费的最小条目集（card / agent WU 消息）。
// 关键性质 = 引用稳定：投影内容未变（人类插话、无 WU 普通 agent 消息等无关增量）时复用旧引用，
// 右栏 memo 边界与下游 useMemo 不破裂。
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useActivityMessageItems } from '../useActivityMessageItems';
import type { ChannelMessage } from '../../api/channel';

function msg(id: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id, channelId: 'ch1', authorType: 'agent', content: `正文${id}`,
    createdAt: '2026-08-10T00:00:00Z', ...over,
  } as ChannelMessage;
}

describe('useActivityMessageItems — #416 消息摘要投影', () => {
  it('投影内容：agent WU 消息 / card 消息进投影，人类与无 WU 普通 agent 消息不进', () => {
    const messages = [
      msg('m1', { workUnitId: 'wu-1' }),
      msg('m2', { authorType: 'human', workUnitId: 'wu-1' }),
      msg('m3'),
      msg('m4', { meta: JSON.stringify({ cardType: 'analysis_confirm' }), workUnitId: 'wu-1', content: '第一行\n第二行' }),
    ];
    const { result } = renderHook(() => useActivityMessageItems(messages));
    expect(result.current.map(i => i.id)).toEqual(['m1', 'm4']);
    expect(result.current[0]).toMatchObject({ kind: 'wu', wuId: 'wu-1' });
    expect(result.current[1]).toMatchObject({ kind: 'card', wuId: 'wu-1' });
    expect(result.current[1].text).toContain('analysis_confirm');
    expect(result.current[1].text).not.toContain('第二行');
  });

  it('无关增量（人类消息 append）→ 返回引用不变', () => {
    const base = [msg('m1', { workUnitId: 'wu-1' })];
    const { result, rerender } = renderHook(
      ({ msgs }) => useActivityMessageItems(msgs),
      { initialProps: { msgs: base } },
    );
    const first = result.current;
    rerender({ msgs: [...base, msg('m2', { authorType: 'human', content: '人类插话' })] });
    expect(result.current).toBe(first);
  });

  it('refresh 同数据（全新数组、投影等值）→ 引用保持', () => {
    const base = [msg('m1', { workUnitId: 'wu-1' })];
    const { result, rerender } = renderHook(
      ({ msgs }) => useActivityMessageItems(msgs),
      { initialProps: { msgs: base } },
    );
    const first = result.current;
    rerender({ msgs: [msg('m1', { workUnitId: 'wu-1' })] });
    expect(result.current).toBe(first);
  });

  it('相关增量（agent WU 消息 append）→ 新引用且含新条目', () => {
    const base = [msg('m1', { workUnitId: 'wu-1' })];
    const { result, rerender } = renderHook(
      ({ msgs }) => useActivityMessageItems(msgs),
      { initialProps: { msgs: base } },
    );
    const first = result.current;
    rerender({ msgs: [...base, msg('m2', { workUnitId: 'wu-1', createdAt: '2026-08-10T00:01:00Z' })] });
    expect(result.current).not.toBe(first);
    expect(result.current.map(i => i.id)).toEqual(['m1', 'm2']);
  });
});
