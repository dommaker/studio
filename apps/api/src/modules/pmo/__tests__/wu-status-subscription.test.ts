/**
 * WuStatusChangedSubscription 单测（P2.1 收敛：三处「订阅 workunit.status_changed」
 * 样板抽出的共享骨架，本文件只锁骨架自身行为——filter / 幂等 / settled 登记；
 * 三消费方的业务语义仍由各自测试覆盖）。
 *
 * 覆盖：
 *  - 幂等：subscribeToEvents 重复调用只挂一次监听（重复订阅防重）
 *  - filter：非匹配事件不触发 handle（各消费方过滤条件不同，由注入侧自定）
 *  - 无 filter 缺省全放行
 *  - waitForSettled：等待在途异步 handle 链落定后才返回（确定性信号）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eventBus } from '@dommaker/studio-shared';
import type { WorkUnitData } from '../../workunit/index.js';
import { WuStatusChangedSubscription } from '../wu-status-subscription.js';

function wu(partial: Partial<WorkUnitData> & { id: string }): WorkUnitData {
  return {
    type: 'analysis',
    status: 'done',
    scope: 's',
    ...partial,
  } as WorkUnitData;
}

function emit(partial: Partial<WorkUnitData> & { id: string }): void {
  eventBus.publish('workunit.status_changed', { workunit: wu(partial) });
}

beforeEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
});

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
});

describe('WuStatusChangedSubscription', () => {
  it('重复 subscribe 只挂一次监听（幂等防重）', () => {
    const sub = new WuStatusChangedSubscription();
    const seen: string[] = [];
    const handler = (w: WorkUnitData) => { seen.push(w.id); return Promise.resolve(); };

    sub.subscribe(undefined, handler);
    sub.subscribe(undefined, handler);
    emit({ id: 'wu-1' });

    expect(seen).toEqual(['wu-1']);
  });

  it('filter 只放行匹配事件（类型 + 状态组合由调用方注入）', () => {
    const sub = new WuStatusChangedSubscription();
    const seen: string[] = [];
    // 照 map-opening 口径：analysis/plan + done
    sub.subscribe(
      (w) => !!w && (w.type === 'analysis' || w.type === 'plan') && w.status === 'done',
      (w) => { seen.push(w.id); return Promise.resolve(); },
    );

    emit({ id: 'hit-analysis', type: 'analysis', status: 'done' });
    emit({ id: 'hit-plan', type: 'plan', status: 'done' });
    emit({ id: 'miss-type', type: 'spec', status: 'done' });
    emit({ id: 'miss-status', type: 'analysis', status: 'in_review' });

    expect(seen).toEqual(['hit-analysis', 'hit-plan']);
  });

  it('缺省 filter 全放行', () => {
    const sub = new WuStatusChangedSubscription();
    const seen: string[] = [];
    sub.subscribe(undefined, (w) => { seen.push(w.id); return Promise.resolve(); });

    emit({ id: 'a', type: 'spec', status: 'active' });
    emit({ id: 'b', type: 'task', status: 'done' });

    expect(seen).toEqual(['a', 'b']);
  });

  it('waitForSettled 等待在途异步链落定（登记的是 handle 返回的 Promise）', async () => {
    const sub = new WuStatusChangedSubscription();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let completed = false;

    sub.subscribe(undefined, async () => { await gate; completed = true; });
    emit({ id: 'wu-async' });

    const settled = sub.waitForSettled();
    // 在途链未落定：此时 waitForSettled 不得返回
    const raced = await Promise.race([
      settled.then(() => 'settled'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(raced).toBe('pending');
    expect(completed).toBe(false);

    release();
    await settled;
    expect(completed).toBe(true);
  });
});
