// F2（2026-09-16 channel 性能体检）：useNeedInputView 引用稳定——页面订阅的是全局 stateItems，
// 他频道 workunit.status_changed → action-center 整体替换重拉时，本频道投影内容等值即复用旧引用，
// 下游 useMemo（deriveStreamView 的 promotedQuestionIds/isWaitingForInput 依赖）不破裂、不白重算。
// 照 useActivityMessageItems stableRef 模式（#416）。
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNeedInputView } from '../useNeedInputView';
import { useNotificationStore, type StateItem } from '../../stores/notificationStore';

function reply(wuId: string, channelId: string, over: Partial<StateItem> = {}): StateItem {
  return {
    kind: 'reply', wuId, scope: `标题${wuId}`, channelId,
    messageId: `mid-${wuId}`, since: '2026-09-16T00:00:00Z', ...over,
  };
}

describe('useNeedInputView — F2 stateItems 全局穿透隔离', () => {
  beforeEach(() => {
    useNotificationStore.setState({ stateItems: [] });
  });

  it('投影内容：本频道 reply 项进 waitingWus，questionIdByWu/promotedQuestionIds/isWaitingForInput 同出一份', () => {
    useNotificationStore.setState({
      stateItems: [reply('wu-1', 'ch-1', { waitingQuestion: '要继续吗' }), reply('wu-2', 'ch-2')],
    });
    const { result } = renderHook(() => useNeedInputView('ch-1'));
    expect(result.current.waitingWus).toEqual([{ wuId: 'wu-1', question: '要继续吗', messageId: 'mid-wu-1' }]);
    expect(result.current.questionIdByWu.get('wu-1')).toBe('mid-wu-1');
    expect(result.current.promotedQuestionIds.has('mid-wu-1')).toBe(true);
    expect(result.current.isWaitingForInput({ id: 'mid-wu-1', workUnitId: 'wu-1' })).toBe(true);
    expect(result.current.isWaitingForInput({ id: 'mid-wu-2', workUnitId: 'wu-2' })).toBe(false);
  });

  it('无关变化（他频道 reply 项新增，整体替换）→ 本频道投影引用不变', () => {
    useNotificationStore.setState({ stateItems: [reply('wu-1', 'ch-1')] });
    const { result } = renderHook(() => useNeedInputView('ch-1'));
    const first = result.current;
    act(() => {
      useNotificationStore.setState({ stateItems: [reply('wu-1', 'ch-1'), reply('wu-9', 'ch-2')] });
    });
    expect(result.current).toBe(first);
  });

  it('等值重拉（全新对象数组、本频道内容等值）→ 引用保持', () => {
    useNotificationStore.setState({ stateItems: [reply('wu-1', 'ch-1')] });
    const { result } = renderHook(() => useNeedInputView('ch-1'));
    const first = result.current;
    act(() => {
      useNotificationStore.setState({ stateItems: [reply('wu-1', 'ch-1')] });
    });
    expect(result.current).toBe(first);
  });

  it('本频道相关变化（新增本频道 reply 项）→ 新引用且含新条目', () => {
    useNotificationStore.setState({ stateItems: [reply('wu-1', 'ch-1')] });
    const { result } = renderHook(() => useNeedInputView('ch-1'));
    const first = result.current;
    act(() => {
      useNotificationStore.setState({ stateItems: [reply('wu-1', 'ch-1'), reply('wu-2', 'ch-1')] });
    });
    expect(result.current).not.toBe(first);
    expect(result.current.waitingWus.map(w => w.wuId)).toEqual(['wu-1', 'wu-2']);
  });

  it('本频道项字段变化（messageId 变）→ 新引用（等值判定不看走眼）', () => {
    useNotificationStore.setState({ stateItems: [reply('wu-1', 'ch-1')] });
    const { result } = renderHook(() => useNeedInputView('ch-1'));
    const first = result.current;
    act(() => {
      useNotificationStore.setState({ stateItems: [reply('wu-1', 'ch-1', { messageId: 'mid-new' })] });
    });
    expect(result.current).not.toBe(first);
    expect(result.current.questionIdByWu.get('wu-1')).toBe('mid-new');
  });
});
