// fanOut（#349）：并行扇出 + 单条失败隔离 + index 对齐归并
import { describe, it, expect } from 'vitest';
import { fanOut } from '../fanOut';

describe('fanOut', () => {
  it('空输入 → 空数组', async () => {
    await expect(fanOut([], async () => 1)).resolves.toEqual([]);
  });

  it('全部成功 → 结果按原顺序 index 对齐', async () => {
    const results = await fanOut([10, 20, 30], async (n) => n * 2);
    expect(results).toEqual([
      { ok: true, value: 20 },
      { ok: true, value: 40 },
      { ok: true, value: 60 },
    ]);
  });

  it('单条失败不炸整批：失败槽 { ok:false, error }，其余槽正常归并，顺序不变', async () => {
    const err = new Error('boom');
    const results = await fanOut(
      ['a', 'b', 'c'],
      async (id) => {
        if (id === 'b') throw err;
        return `ok:${id}`;
      },
    );
    expect(results).toEqual([
      { ok: true, value: 'ok:a' },
      { ok: false, error: err },
      { ok: true, value: 'ok:c' },
    ]);
  });

  it('fetcher 同步 throw 同样隔离，不炸整批', async () => {
    const err = new Error('sync boom');
    const results = await fanOut([1, 2], (n) => {
      if (n === 1) throw err;
      return Promise.resolve(n);
    });
    expect(results).toEqual([
      { ok: false, error: err },
      { ok: true, value: 2 },
    ]);
  });

  it('非 Error 的拒绝原因原样透传', async () => {
    const results = await fanOut(['x'], () => Promise.reject('string reason'));
    expect(results).toEqual([{ ok: false, error: 'string reason' }]);
  });
});
