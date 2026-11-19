import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FileStore,
  type AgentProfileData,
  type WorkUnitSnapshot,
} from '@dommaker/studio-shared';
import { LoopObserver } from '../loop-observe.js';

const CHANNEL_ID = 'ch-shared';

function role(id: string): AgentProfileData {
  const now = new Date().toISOString();
  return {
    id, name: id, description: null, channels: '[]', status: 'active', provider: null,
    createdAt: now, updatedAt: now,
  };
}

function snapshot(id: string, createdAtMs: number): WorkUnitSnapshot {
  return {
    id, parentId: null, type: 'task', scope: `shared-${id}`, assigneeId: null,
    status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: CHANNEL_ID, projectPath: null, workspaceId: null, metadata: null,
    createdAt: new Date(createdAtMs).toISOString(), updatedAt: new Date().toISOString(),
    claimedAt: null, completedAt: null,
  };
}

describe('PERF-03 AgentLoop 单观察协调器', () => {
  let testDir: string;
  let fileStore: FileStore;
  let snapshots: WorkUnitSnapshot[];
  let getIndex: ReturnType<typeof vi.spyOn>;
  let listChannels: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-observation-coordinator-'));
    fileStore = new FileStore(testDir);
    snapshots = [snapshot('wu-1', 1_000)];
    getIndex = vi.spyOn(fileStore, 'getIndex').mockImplementation(async () => snapshots);
    // 频道 map miss 保持既有“放行不裁决”语义，聚焦本轮读取去重。
    listChannels = vi.spyOn(fileStore, 'listChannels').mockImplementation(async () => []);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function observers(count: number): LoopObserver[] {
    return Array.from({ length: count }, (_, index) => new LoopObserver({
      role: role(`role-${index}`), fileStore,
      getInstance: () => null,
      isAlive: () => true,
    }));
  }

  it('并发唤醒共享 single-flight，只读一次并向全部角色分发', async () => {
    let release!: (value: WorkUnitSnapshot[]) => void;
    getIndex.mockImplementation(() => new Promise<WorkUnitSnapshot[]>(resolve => { release = resolve; }));
    const pending = observers(50).map(observer => observer.observe());
    try {
      expect(getIndex).toHaveBeenCalledTimes(1);
    } finally {
      release(snapshots);
      await Promise.all(pending);
    }
    expect(listChannels).toHaveBeenCalledTimes(1);
  });

  it.each(['invalidate', 'indexVersion'] as const)('加载中发生 %s：当前唤醒调用立即改挂新加载，旧完成不得覆盖新视图', async mode => {
    const oldSnapshots = snapshots;
    const resolvers: Array<(value: WorkUnitSnapshot[]) => void> = [];
    getIndex.mockImplementation(() => new Promise<WorkUnitSnapshot[]>(resolve => { resolvers.push(resolve); }));
    const observer = observers(1)[0];
    const first = observer.observe();
    snapshots = [snapshot('wu-2', 2_000)];
    if (mode === 'invalidate') {
      observer.onWorkUnitClaimable({ workunit: { id: 'wu-2', claimable: true } });
    } else {
      // 真实写路径推进 FileStore 版本；只 mock 存储返回内容，不 mock 版本本身。
      await fileStore.upsertSnapshot(snapshot('wu-real-write', 3_000));
    }
    const awakened = observer.observe();

    try {
      expect(getIndex).toHaveBeenCalledTimes(2);
      // 新加载先完成：当前唤醒调用必须看到新 target。
      resolvers[1](snapshots);
      expect((await awakened).unassigned[0]?.id).toBe('wu-2');
      // 旧加载后完成：不得把新 cache 覆盖回旧视图。
      resolvers[0](oldSnapshots);
      await first;
      expect((await observer.observe()).unassigned[0]?.id).toBe('wu-2');
      expect(getIndex).toHaveBeenCalledTimes(2);
    } finally {
      for (const resolve of resolvers) resolve(snapshots);
      await Promise.allSettled([first, awakened]);
    }
  });

  it('同一 index version 的顺序观察复用 fold/排序结果，不重复读取', async () => {
    const views = [] as Awaited<ReturnType<LoopObserver['observe']>>[];
    for (const observer of observers(20)) views.push(await observer.observe());

    expect(getIndex).toHaveBeenCalledTimes(1);
    expect(listChannels).toHaveBeenCalledTimes(1);
    expect(views.every(view => view.unassigned[0]?.id === 'wu-1')).toBe(true);
  });

  it('claimable 事件推进观察版本，下一批角色仍只共同读取一次', async () => {
    const loops = observers(20);
    await Promise.all(loops.map(observer => observer.observe()));
    snapshots = [snapshot('wu-2', 2_000)];
    for (const observer of loops) {
      observer.onWorkUnitClaimable({ workunit: { id: 'wu-2', claimable: true } });
    }
    const views = await Promise.all(loops.map(observer => observer.observe()));

    expect(getIndex).toHaveBeenCalledTimes(2);
    expect(listChannels).toHaveBeenCalledTimes(2);
    expect(views.every(view => view.unassigned[0]?.id === 'wu-2')).toBe(true);
  });

  it('共享读取失败不缓存错误，下一批观察可重试成功', async () => {
    getIndex.mockRejectedValueOnce(new Error('temporary index failure'));
    const loops = observers(10);
    await expect(Promise.all(loops.map(observer => observer.observe()))).rejects.toThrow('temporary index failure');
    expect(getIndex).toHaveBeenCalledTimes(1);

    const views = await Promise.all(loops.map(observer => observer.observe()));
    expect(getIndex).toHaveBeenCalledTimes(2);
    expect(views).toHaveLength(10);
  });

  it('15 秒兜底同时唤醒的角色共享一轮新观察', async () => {
    vi.useFakeTimers();
    const loops = observers(50);
    await Promise.all(loops.map(observer => observer.observe()));
    expect(getIndex).toHaveBeenCalledTimes(1);

    const awakened = loops.map(observer => observer.idleSleep(15_000).then(() => observer.observe()));
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all(awakened);

    expect(getIndex).toHaveBeenCalledTimes(2);
    expect(listChannels).toHaveBeenCalledTimes(2);
  });

  it.each([
    [10, 1_000], [10, 10_000],
    [50, 1_000], [50, 10_000],
    [200, 1_000], [200, 10_000],
  ])('规模诊断：%i 角色 × %i WU 的读取随角色数近似常数', async (roleCount, wuCount) => {
    snapshots = Array.from({ length: wuCount }, (_, index) => snapshot(`wu-${index}`, index + 1));
    const loops = observers(roleCount);
    let activeReads = 0;
    let wakePeak = 0;
    getIndex.mockImplementation(async () => {
      activeReads += 1;
      wakePeak = Math.max(wakePeak, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      return snapshots;
    });
    const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();

    // 同版本空闲重复观察 + 一次事件版本推进；两轮都应各只读一次。
    await Promise.all(loops.map(observer => observer.observe()));
    await Promise.all(loops.map(observer => observer.observe()));
    const idleIndexReads = getIndex.mock.calls.length;
    for (const observer of loops) observer.onWorkUnitClaimable({ workunit: { claimable: true } });
    await Promise.all(loops.map(observer => observer.observe()));

    const cpu = process.cpuUsage(cpuStart);
    histogram.disable();
    const diagnostics = {
      roles: roleCount,
      workUnits: wuCount,
      idleIndexReads,
      totalIndexReads: getIndex.mock.calls.length,
      channelReads: listChannels.mock.calls.length,
      wakePeak,
      wallMs: Number((performance.now() - wallStart).toFixed(1)),
      cpuUserMs: Number((cpu.user / 1000).toFixed(1)),
      cpuSystemMs: Number((cpu.system / 1000).toFixed(1)),
      eventLoopP99Ms: Number((histogram.percentile(99) / 1e6).toFixed(1)),
      eventLoopMaxMs: Number((histogram.max / 1e6).toFixed(1)),
    };
    console.info(`[PERF-03] ${JSON.stringify(diagnostics)}`);

    expect(idleIndexReads).toBe(1);
    expect(getIndex).toHaveBeenCalledTimes(2);
    expect(listChannels).toHaveBeenCalledTimes(2);
    expect(wakePeak).toBe(1);
    // PERF-07 才设统一性能硬门；这里只保证诊断值有效，不用阈值删弱断言。
    expect(diagnostics.eventLoopP99Ms).toBeGreaterThanOrEqual(0);
    expect(diagnostics.cpuUserMs).toBeGreaterThanOrEqual(0);
  });
});
