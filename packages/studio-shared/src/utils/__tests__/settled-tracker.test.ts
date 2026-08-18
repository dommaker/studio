/** createSettledTracker（#228）：fire-and-forget 链的确定性等待原语 */
import { describe, it, expect } from 'vitest';
import { createSettledTracker } from '../settled-tracker';

describe('createSettledTracker', () => {
  it('无在途时 waitForSettled 立即返回', async () => {
    const tracker = createSettledTracker();
    await tracker.waitForSettled(); // 不挂起即通过
  });

  it('track 登记后 waitForSettled 等到链落定', async () => {
    const tracker = createSettledTracker();
    let settled = false;
    tracker.track(new Promise<void>(r => setTimeout(() => { settled = true; r(); }, 30)));
    await tracker.waitForSettled();
    expect(settled).toBe(true);
  });

  it('多条在途全部等完', async () => {
    const tracker = createSettledTracker();
    const flags = [false, false, false];
    flags.forEach((_, i) => {
      tracker.track(new Promise<void>(r => setTimeout(() => { flags[i] = true; r(); }, 10 * (i + 1))));
    });
    await tracker.waitForSettled();
    expect(flags).toEqual([true, true, true]);
  });

  it('rejected 链不阻塞等待（Promise.allSettled 语义）', async () => {
    const tracker = createSettledTracker();
    tracker.track(Promise.reject(new Error('boom')).catch(() => {}));
    await tracker.waitForSettled(); // 不抛、不挂起即通过
  });

  it('级联：等待期间新登记的链也一并等完', async () => {
    const tracker = createSettledTracker();
    let cascaded = false;
    tracker.track((async () => {
      await new Promise(r => setTimeout(r, 10));
      tracker.track(new Promise<void>(r => setTimeout(() => { cascaded = true; r(); }, 10)));
    })());
    await tracker.waitForSettled();
    expect(cascaded).toBe(true);
  });

  it('落定后登记移除：再次 waitForSettled 立即返回', async () => {
    const tracker = createSettledTracker();
    tracker.track(Promise.resolve());
    await tracker.waitForSettled();
    await tracker.waitForSettled(); // 立即返回即通过
  });
});
