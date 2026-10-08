/**
 * bootstrap/soft-steps 测试（#686）：「失败只 log 不拒启」纪律的唯一固化点。
 * runSoftSteps：按表顺序执行、单项失败（同步抛/异步拒）只 warn 后继续、不外抛；
 * mountSoftSteps：同步返回、加载/挂载失败只 warn 不产生未处理拒绝。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '@dommaker/studio-shared';
import { runSoftSteps, mountSoftSteps } from '../soft-steps.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runSoftSteps', () => {
  it('按表顺序逐项执行', async () => {
    const calls: string[] = [];
    await runSoftSteps([
      { name: 'a', run: () => { calls.push('a'); } },
      { name: 'b', run: async () => { calls.push('b'); } },
    ]);
    expect(calls).toEqual(['a', 'b']);
  });

  it('单项同步抛错只 warn，不阻断后续、不外抛', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    await expect(runSoftSteps([
      { name: 'bad', run: () => { throw new Error('boom'); } },
      { name: 'good', run: () => { calls.push('good'); } },
    ])).resolves.toBeUndefined();
    expect(calls).toEqual(['good']);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('bad');
  });

  it('单项异步拒绝同样只 warn 后继续', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    await runSoftSteps([
      { name: 'bad', run: async () => { throw new Error('boom'); } },
      { name: 'good', run: () => { calls.push('good'); } },
    ]);
    expect(calls).toEqual(['good']);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('mountSoftSteps', () => {
  it('同步返回，各步被触达（fire-and-forget）', async () => {
    const calls: string[] = [];
    expect(() => mountSoftSteps([
      { name: 'a', run: async () => { calls.push('a'); } },
      { name: 'b', run: async () => { calls.push('b'); } },
    ])).not.toThrow();
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b']));
  });

  it('加载/挂载失败只 warn，同步路径不抛', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(() => mountSoftSteps([
      { name: 'bad', run: async () => { throw new Error('boom'); } },
    ])).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(warn.mock.calls[0][0]).toContain('bad');
  });
});
