// rosterActivityStore — #348 执行动态 store：追加/同 key 刷新/上限截断 + 卡片级切片订阅契约
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useRosterActivityStore,
  useRosterActivities,
  pushActivity,
  MAX_ACTIVITIES,
  type RosterActivityItem,
} from '../rosterActivityStore';

const item = (text: string, key?: string): RosterActivityItem => ({ at: 't', text, ...(key ? { key } : {}) });

describe('pushActivity', () => {
  it('无 key 追加；同 key 替换尾条（流式 chunk 刷新同一行）', () => {
    expect(pushActivity([], item('a'))).toHaveLength(1);
    const list = pushActivity([item('先读', 'stream:2:thinking')], item('先读现有实现', 'stream:2:thinking'));
    expect(list).toEqual([item('先读现有实现', 'stream:2:thinking')]);
  });

  it('超上限丢最旧', () => {
    let list: RosterActivityItem[] = [];
    for (let i = 0; i < MAX_ACTIVITIES + 3; i++) list = pushActivity(list, item(`n${i}`, `k${i}`));
    expect(list).toHaveLength(MAX_ACTIVITIES);
    expect(list[0].text).toBe('n3');
  });
});

describe('useRosterActivityStore', () => {
  beforeEach(() => useRosterActivityStore.getState().resetActivities());

  it('appendActivity 建片；他卡切片引用不变（memo/selector 契约）', () => {
    useRosterActivityStore.getState().appendActivity('p1', item('a'));
    const p1Before = useRosterActivityStore.getState().activities.p1;
    useRosterActivityStore.getState().appendActivity('p2', item('b'));
    const s = useRosterActivityStore.getState().activities;
    expect(s.p1).toBe(p1Before);
    expect(s.p2).toEqual([item('b')]);
  });

  it('resetActivities 清空', () => {
    useRosterActivityStore.getState().appendActivity('p1', item('a'));
    useRosterActivityStore.getState().resetActivities();
    expect(useRosterActivityStore.getState().activities).toEqual({});
  });
});

describe('useRosterActivities — 卡片级切片订阅（#348 渲染边界核心契约）', () => {
  beforeEach(() => useRosterActivityStore.getState().resetActivities());

  it('未落动态返回稳定空引用；他卡更新不换引用；本卡更新换引用', () => {
    const { result } = renderHook(() => useRosterActivities('p1'));
    const empty = result.current;
    expect(empty).toEqual([]);

    act(() => useRosterActivityStore.getState().appendActivity('p2', item('别人的')));
    expect(result.current).toBe(empty);

    act(() => useRosterActivityStore.getState().appendActivity('p1', item('我的')));
    expect(result.current).not.toBe(empty);
    expect(result.current).toEqual([item('我的')]);
  });
});
