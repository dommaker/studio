// useChannelDrawers（P3-b 自 ChannelDetailPage 切出）——右抽屉 + 转任务弹窗状态：
// openWu/openWuConfirm/autoRuling/autoDirection/openReq 各入口 DrawerState 形状 +
// closeDrawer/closeConvert 复位 + #322 稳定 props 契约（回调引用跨渲染不换）
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChannelMessage } from '../../api/channel';
import { useChannelDrawers } from '../useChannelDrawers';

describe('useChannelDrawers — P3-b 抽屉/弹窗状态', () => {
  it('openWu → wu 抽屉；openReq → req 抽屉；closeDrawer 复位', () => {
    const { result } = renderHook(() => useChannelDrawers());
    expect(result.current.drawer).toBeNull();
    act(() => result.current.openWu('wu-1'));
    expect(result.current.drawer).toEqual({ kind: 'wu', id: 'wu-1' });
    act(() => result.current.openReq('REQ-1'));
    expect(result.current.drawer).toEqual({ kind: 'req', id: 'REQ-1' });
    act(() => result.current.closeDrawer());
    expect(result.current.drawer).toBeNull();
  });

  it('三种自动动作入口：autoApprove / autoRuling / autoDirection 旗标', () => {
    const { result } = renderHook(() => useChannelDrawers());
    act(() => result.current.openWuConfirm('wu-1'));
    expect(result.current.drawer).toEqual({ kind: 'wu', id: 'wu-1', autoApprove: true });
    act(() => result.current.openWuRuling('wu-2'));
    expect(result.current.drawer).toEqual({ kind: 'wu', id: 'wu-2', autoRuling: true });
    act(() => result.current.openWuDirection('wu-3'));
    expect(result.current.drawer).toEqual({ kind: 'wu', id: 'wu-3', autoDirection: true });
  });

  it('转任务弹窗页面级单例：openConvert 持目标消息，closeConvert 复位', () => {
    const { result } = renderHook(() => useChannelDrawers());
    const msg = { id: 'm-1' } as ChannelMessage;
    expect(result.current.convertTarget).toBeNull();
    act(() => result.current.openConvert(msg));
    expect(result.current.convertTarget).toBe(msg);
    act(() => result.current.closeConvert());
    expect(result.current.convertTarget).toBeNull();
  });

  it('#322 稳定 props 契约：全部回调引用跨渲染不换', () => {
    const { result, rerender } = renderHook(() => useChannelDrawers());
    const before = { ...result.current };
    act(() => before.openWu('wu-1'));
    rerender();
    for (const key of ['openWu', 'openWuConfirm', 'openWuRuling', 'openWuDirection', 'openReq', 'closeDrawer', 'openConvert', 'closeConvert'] as const) {
      expect(result.current[key]).toBe(before[key]);
    }
  });
});
