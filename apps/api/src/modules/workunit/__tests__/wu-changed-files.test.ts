/**
 * #285 AC4（决策 #249 §5）：per-WU 产出/修改文件集最小查询面 ——
 * wu-changed-files 服务函数测试（注入 readEvents，不落盘）。
 */
import { describe, it, expect } from 'vitest';
import { listWorkUnitChangedFiles, listWorkUnitsChangedFiles } from '../wu-changed-files.js';

const ev = (type: string, payload: unknown) => ({ type, payload: JSON.stringify(payload) });

describe('listWorkUnitChangedFiles（#285 AC4：WU 产出/修改文件集）', () => {
  it('session:start 带 workUnitId → 关联 file:change 路径去重保序返回', async () => {
    const events = [
      ev('session:start', { sessionId: 'sess-1', workUnitId: 'wu-1' }),
      ev('file:change', { sessionId: 'sess-1', path: '/wt/exec-1/src/a.ts' }),
      ev('file:change', { sessionId: 'sess-1', path: '/wt/exec-1/src/b.ts' }),
      ev('file:change', { sessionId: 'sess-1', path: '/wt/exec-1/src/a.ts' }), // 重复去重
      ev('session:start', { sessionId: 'sess-2', workUnitId: 'wu-1' }), // 同 WU 第二个 session
      ev('file:change', { sessionId: 'sess-2', path: '/wt/exec-2/src/c.ts' }),
    ];
    const files = await listWorkUnitChangedFiles('wu-1', { readEvents: async () => events });
    expect(files).toEqual(['/wt/exec-1/src/a.ts', '/wt/exec-1/src/b.ts', '/wt/exec-2/src/c.ts']);
  });

  it('其他 WU / 无 workUnitId 的 session 不混入；无关联 session → 空数组', async () => {
    const events = [
      ev('session:start', { sessionId: 'sess-9', workUnitId: 'wu-other' }),
      ev('file:change', { sessionId: 'sess-9', path: '/wt/x/y.ts' }),
      ev('session:start', { sessionId: 'sess-10' }), // 无 workUnitId（非 WU 执行）
      ev('file:change', { sessionId: 'sess-10', path: '/wt/x/z.ts' }),
      ev('file:change', { sessionId: 'sess-orphan', path: '/wt/x/o.ts' }), // 无 session:start
    ];
    expect(await listWorkUnitChangedFiles('wu-1', { readEvents: async () => events })).toEqual([]);
  });

  it('畸形行（payload 损坏 / path 非字符串）跳过不编造', async () => {
    const events = [
      ev('session:start', { sessionId: 'sess-1', workUnitId: 'wu-1' }),
      { type: 'file:change', payload: '{broken json' },
      ev('file:change', { sessionId: 'sess-1', path: 42 }),
      ev('file:change', { sessionId: 'sess-1', path: '' }),
      ev('file:change', { sessionId: 'sess-1', path: '/wt/exec-1/ok.ts' }),
    ];
    expect(await listWorkUnitChangedFiles('wu-1', { readEvents: async () => events }))
      .toEqual(['/wt/exec-1/ok.ts']);
  });

  it('事件读取失败 → 空数组降级，绝不抛出（调用方降级候选集词表）', async () => {
    await expect(listWorkUnitChangedFiles('wu-1', {
      readEvents: async () => { throw new Error('disk gone'); },
    })).resolves.toEqual([]);
  });
});

describe('listWorkUnitsChangedFiles（2026-09-25 批量版：一次窗口读派生全部 WU）', () => {
  it('多 WU 一次派生：各自归属隔离、去重保序、无数据 WU 空数组', async () => {
    const events = [
      ev('session:start', { sessionId: 'sess-1', workUnitId: 'wu-1' }),
      ev('session:start', { sessionId: 'sess-2', workUnitId: 'wu-2' }),
      ev('file:change', { sessionId: 'sess-1', path: '/wt/a/x.ts' }),
      ev('file:change', { sessionId: 'sess-2', path: '/wt/b/y.ts' }),
      ev('file:change', { sessionId: 'sess-1', path: '/wt/a/x.ts' }), // 重复去重
      ev('file:change', { sessionId: 'sess-orphan', path: '/wt/o.ts' }), // 无归属 session
    ];
    const map = await listWorkUnitsChangedFiles(['wu-1', 'wu-2', 'wu-3'], { readEvents: async () => events });
    expect(map).toEqual({
      'wu-1': ['/wt/a/x.ts'],
      'wu-2': ['/wt/b/y.ts'],
      'wu-3': [],
    });
  });

  it('ids 去重、空串滤除；空 ids → 空映射', async () => {
    const events = [ev('session:start', { sessionId: 'sess-1', workUnitId: 'wu-1' })];
    const map = await listWorkUnitsChangedFiles(['wu-1', 'wu-1', ''], { readEvents: async () => events });
    expect(Object.keys(map)).toEqual(['wu-1']);
    expect(await listWorkUnitsChangedFiles([], { readEvents: async () => events })).toEqual({});
  });

  it('事件读取失败 → 全部空集降级，绝不抛出', async () => {
    await expect(listWorkUnitsChangedFiles(['wu-1', 'wu-2'], {
      readEvents: async () => { throw new Error('disk gone'); },
    })).resolves.toEqual({ 'wu-1': [], 'wu-2': [] });
  });

  it('单发 listWorkUnitChangedFiles 与批量同口径（委托同一路径）', async () => {
    const events = [
      ev('session:start', { sessionId: 'sess-1', workUnitId: 'wu-1' }),
      ev('file:change', { sessionId: 'sess-1', path: '/wt/a/x.ts' }),
    ];
    await expect(listWorkUnitChangedFiles('wu-1', { readEvents: async () => events }))
      .resolves.toEqual(['/wt/a/x.ts']);
  });
});
