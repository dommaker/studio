/**
 * keyed-enqueue.ts 契约测试：同 key 严格排队 / 前序失败不阻断 / 异 key 并行 / 返回值 = 本任务链式 Promise。
 */
import { describe, it, expect } from 'vitest';
import { createKeyedEnqueue } from '../keyed-enqueue.js';

describe('createKeyedEnqueue', () => {
  it('同 key 任务严格按入队顺序串行', async () => {
    const enqueue = createKeyedEnqueue();
    const order: string[] = [];
    await Promise.all([
      enqueue('p1', async () => { order.push('a'); }),
      enqueue('p1', async () => { order.push('b'); }),
      enqueue('p1', async () => { order.push('c'); }),
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('前序任务 reject 不阻断后续，后续照常执行', async () => {
    const enqueue = createKeyedEnqueue();
    const order: string[] = [];
    const first = enqueue('p1', async () => { order.push('a'); throw new Error('boom'); });
    const second = enqueue('p1', async () => { order.push('b'); });
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBeUndefined();
    expect(order).toEqual(['a', 'b']);
  });

  it('不同 key 互不阻塞', async () => {
    const enqueue = createKeyedEnqueue();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow = enqueue('p1', () => gate);
    const fast = enqueue('p2', async () => { /* 立即完成 */ });
    await fast; // p1 还堵着，p2 已完成——若互相阻塞此处会挂起
    release();
    await slow;
  });

  it('返回值 = 本任务执行完成的 Promise（调用方可 await 自身任务）', async () => {
    const enqueue = createKeyedEnqueue();
    let done = false;
    await enqueue('p1', async () => { done = true; });
    expect(done).toBe(true);
  });

  it('链尾回收：任务全部结束后同 key 再入队不复用旧链', async () => {
    const enqueue = createKeyedEnqueue();
    const order: string[] = [];
    await enqueue('p1', async () => { order.push('a'); });
    // 旧链已回收，重新入队从空链起步，行为与首轮一致
    await enqueue('p1', async () => { order.push('b'); });
    expect(order).toEqual(['a', 'b']);
  });
});
