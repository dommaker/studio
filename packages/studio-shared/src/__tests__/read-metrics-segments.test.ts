/**
 * #411：read-metrics 段事件（exec / harness 调用级 span）测试（先行 RED）。
 *
 * 覆盖：
 *  - runSegmentSpan：同步/Promise/throw 三态的事件完整性与返回值透传
 *  - ALS 归因：label 沿用 runWithLoopLabel 上下文
 *  - 嵌套去重：harness 段嵌套（facade 内 store 调用）只记顶层
 *  - sink 关闭（默认 null）：零行为变化（原值透传、无事件、无包装开销路径）
 *  - wrapWithSegmentSpan：方法包装、this 绑定、自有字段保留、缺席方法容忍、sink 异常不外泄
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setReadMetricsSink,
  runWithLoopLabel,
  setSegmentMetricsSink,
  runSegmentSpan,
  wrapWithSegmentSpan,
  emitReadMetric,
  readMetricsBegin,
  type SegmentMetricEvent,
  type ReadMetricEvent,
} from '../read-metrics';

let events: SegmentMetricEvent[];
let readEvents: ReadMetricEvent[];

beforeEach(() => {
  events = [];
  readEvents = [];
  setSegmentMetricsSink(e => events.push(e));
  setReadMetricsSink(e => readEvents.push(e));
});

afterEach(() => {
  setSegmentMetricsSink(null);
  setReadMetricsSink(null);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 在当前上下文发一条合成读口事件（statMs 合成值，不碰真实 I/O） */
function fakeRead(statMs: number): void {
  if (!readMetricsBegin()) return;
  emitReadMetric({ file: '/tmp/x.json', op: 'readJson', cacheHit: false, statMs, readParseMs: 0, cloneMs: 0 });
}

describe('runSegmentSpan', () => {
  it('同步 fn：事件字段完整，返回值透传', () => {
    const out = runSegmentSpan('harness', 'FileKnowledgeStore.list', () => 42);
    expect(out).toBe(42);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'harness', name: 'FileKnowledgeStore.list', loop: 'unlabeled' });
    expect(events[0].ms).toBeGreaterThanOrEqual(0);
  });

  it('Promise fn：span 覆盖到 settle，resolve 值透传', async () => {
    const out = await runSegmentSpan('exec', 'git worktree prune', async () => {
      await new Promise(r => setTimeout(r, 15));
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('exec');
    expect(events[0].ms).toBeGreaterThanOrEqual(10);
  });

  it('Promise reject：事件仍发出，异常原样透传', async () => {
    await expect(
      runSegmentSpan('exec', 'npx tsx src/cli/studio-cli.ts status', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('npx tsx src/cli/studio-cli.ts status');
  });

  it('同步 throw：事件仍发出，异常原样透传', () => {
    expect(() => runSegmentSpan('harness', 'KnowledgeLinter.run', () => { throw new Error('sync'); })).toThrow('sync');
    expect(events).toHaveLength(1);
  });

  it('ALS：runWithLoopLabel 内的事件带 label；并发互不串扰', async () => {
    await runWithLoopLabel('monitor-round', async () => {
      await runSegmentSpan('exec', 'git worktree prune', async () => {
        await new Promise(r => setTimeout(r, 5));
      });
    });
    const tick = () => new Promise(r => setTimeout(r, 5));
    await Promise.all([
      runWithLoopLabel('loop-a', () => runSegmentSpan('exec', 'a', async () => { await tick(); })),
      runWithLoopLabel('loop-b', () => runSegmentSpan('exec', 'b', async () => { await tick(); })),
    ]);
    expect(events[0].loop).toBe('monitor-round');
    expect(events.filter(e => e.loop === 'loop-a')).toHaveLength(1);
    expect(events.filter(e => e.loop === 'loop-b')).toHaveLength(1);
  });

  it('嵌套去重：harness facade 内的 store 调用只记顶层一个事件', () => {
    const out = runSegmentSpan('harness', 'KnowledgeLinter.run', () =>
      runSegmentSpan('harness', 'FileKnowledgeStore.list', () =>
        runSegmentSpan('harness', 'FileKnowledgeStore.readIndex', () => 'deep'),
      ),
    );
    expect(out).toBe('deep');
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('KnowledgeLinter.run');
  });

  it('顶层 span 串行复用：前一个关闭后，下一个仍记顶层', () => {
    runSegmentSpan('harness', 'A', () => runSegmentSpan('harness', 'A-inner', () => 1));
    runSegmentSpan('harness', 'B', () => 2);
    expect(events.map(e => e.name)).toEqual(['A', 'B']);
  });

  it('sink 抛异常：吞掉，不改变业务行为', async () => {
    setSegmentMetricsSink(() => { throw new Error('sink blew up'); });
    expect(runSegmentSpan('exec', 'x', () => 'fine')).toBe('fine');
    await expect(runSegmentSpan('exec', 'x-async', async () => 'async-fine')).resolves.toBe('async-fine');
  });

  it('自耗时口径：span 内嵌套读口事件耗时段内扣除（与读口段不相交）', async () => {
    await runSegmentSpan('harness', 'A', async () => { await sleep(60); });
    await runSegmentSpan('harness', 'B', async () => {
      fakeRead(30);
      await sleep(60);
    });
    // 同为 ~60ms 的 span，B 内多出 30ms 合成读口 → 自耗时显著小于 A
    const msNoRead = events.find(e => e.name === 'A')!.ms;
    const msWithRead = events.find(e => e.name === 'B')!.ms;
    expect(msWithRead).toBeLessThan(msNoRead - 20);
  });

  it('自耗时口径：嵌套 span 内的读口只从顶层扣一次', async () => {
    await runSegmentSpan('harness', 'A', async () => {
      await runSegmentSpan('harness', 'A-inner', async () => { await sleep(60); });
    });
    await runSegmentSpan('harness', 'B', async () => {
      await runSegmentSpan('harness', 'B-inner', async () => {
        fakeRead(30);
        await sleep(60);
      });
    });
    // 嵌套 span 不发事件，只有顶层一条
    expect(events.map(e => e.name)).toEqual(['A', 'B']);
    const msNoRead = events.find(e => e.name === 'A')!.ms;
    const msWithRead = events.find(e => e.name === 'B')!.ms;
    expect(msWithRead).toBeLessThan(msNoRead - 20);
  });
});

describe('sink 关闭（默认 null）', () => {
  it('fn 原样执行，无事件', () => {
    setSegmentMetricsSink(null);
    const out = runSegmentSpan('harness', 'FileKnowledgeStore.list', () => 7);
    expect(out).toBe(7);
    expect(events).toHaveLength(0);
  });
});

describe('wrapWithSegmentSpan', () => {
  class FakeStore {
    calls: string[] = [];
    get(id: string): string { this.calls.push(`get:${id}`); return `entry-${id}`; }
    list(filter?: string): string[] { this.calls.push(`list:${filter ?? ''}`); return ['a']; }
    getBaseDir(): string { this.calls.push('getBaseDir'); return '/base'; }
  }

  it('列内方法被包装并发事件，未列方法与自有字段不动', () => {
    const store = wrapWithSegmentSpan(new FakeStore(), 'FileKnowledgeStore', ['get', 'list']);

    expect(store.get('x1')).toBe('entry-x1');
    expect(store.getBaseDir()).toBe('/base');
    expect((store as FakeStore).calls).toEqual(['get:x1', 'getBaseDir']);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'harness', name: 'FileKnowledgeStore.get' });
  });

  it('this 绑定保持：包装方法内 this 指向原对象', () => {
    const store = wrapWithSegmentSpan(new FakeStore(), 'FileKnowledgeStore', ['get']);
    expect(store.get('bound')).toBe('entry-bound');
    expect((store as FakeStore).calls).toContain('get:bound');
  });

  it('缺席方法容忍（harness 版本差异）：不抛错、其余方法照常包装', () => {
    const store = wrapWithSegmentSpan(new FakeStore(), 'KnowledgeStore', ['list', 'notInVersion']);
    expect(store.list('f')).toEqual(['a']);
    expect(events).toHaveLength(1);
  });

  it('包装后嵌套：对象方法互调只记顶层', () => {
    const nested = {
      outer(): string { return this.inner(); },
      inner(): string { return 'deep'; },
    };
    wrapWithSegmentSpan(nested, 'Facade', ['outer', 'inner']);
    expect(nested.outer()).toBe('deep');
    expect(events.map(e => e.name)).toEqual(['Facade.outer']);
  });

  it('sink 关闭时包装对象行为不变', () => {
    setSegmentMetricsSink(null);
    const store = wrapWithSegmentSpan(new FakeStore(), 'FileKnowledgeStore', ['get', 'list']);
    expect(store.get('a')).toBe('entry-a');
    expect(store.list('f')).toEqual(['a']);
    expect(events).toHaveLength(0);
  });
});
