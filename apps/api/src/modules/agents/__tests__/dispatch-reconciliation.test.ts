/**
 * #183（#159 + #66 决议①）派工/评审断链 5min 对账扫描：
 *  - analysis 侧：哨兵清单化（analysisTasksSpawned 记已建子 WU id）→ 对账补差集自愈；
 *    补建前 parentId+scope 活体去重；人工关单（在清单中）不复活；旧时间戳哨兵兼容跳过；
 *    哨兵落档 <10min 不参与对账；重跑记尝试数，3 次仍败停跑并升 critical
 *  - review 侧：父 WU in_review ≥10min 且无未完结 review 子 WU → 幂等重跑路径 A，
 *    warning 事件 review.redispatched 走 #62 告警管线（频道不出声）
 * 真实 FileStore（tmpdir）+ 真实 WorkUnitService/ReviewDispatcher/AnalysisHandoff；
 * 告警出口 dispatchMonitorAlerts mock；结构化事件读 STUDIO_EVENTS_FILE 落盘断言。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service.js';

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));

vi.mock('../monitor/monitor-alerts.js', () => ({
  dispatchMonitorAlerts: mockDispatch,
}));

import { reconcileDispatchBreaks, MAX_RECONCILE_ATTEMPTS } from '../dispatch-reconciliation';
import { AnalysisHandoff } from '../../pmo/analysis-handoff.js';

let tmpDir: string;
let eventsFile: string;
let fileStore: FileStore;
let wuService: WorkUnitService;

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function metaOf(raw: string | null): WorkUnitMetadata {
  return raw ? JSON.parse(raw) as WorkUnitMetadata : {};
}

async function readMeta(wuId: string): Promise<WorkUnitMetadata> {
  return metaOf((await wuService.getById(wuId))!.metadata);
}

async function readStudioEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    return fs.readFileSync(eventsFile, 'utf-8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function eventsOfType(type: string) {
  return (await readStudioEvents()).filter(e => e.type === type);
}

/** 回填 updatedAt（review 侧 in_review 时长以 updatedAt 为锚） */
async function backdateUpdatedAt(wuId: string, iso: string): Promise<void> {
  const snaps = await fileStore.getIndex();
  const s = snaps.find(x => x.id === wuId);
  if (!s) throw new Error(`snapshot not found: ${wuId}`);
  await fileStore.upsertSnapshot({ ...s, updatedAt: iso });
}

async function childrenOf(parentId: string): Promise<WorkUnitData[]> {
  return (await wuService.list({ parentId, limit: 1000 })).data;
}

/** 造一枚「哨兵已落清单」的 done analysis WU；childScopes 会真实建子 WU 并记入清单 */
async function createAnalysisWithSentinel(opts: {
  tasks: string[];
  childScopes?: string[];
  childStatus?: string;
  sentinelAgeMin?: number;
  attempts?: number;
  legacyTimestampOnly?: boolean;
}): Promise<WorkUnitData> {
  const metadata: WorkUnitMetadata = {
    analysisTasks: opts.tasks,
    analysisTasksSpawnedAt: minutesAgo(opts.sentinelAgeMin ?? 15),
    ...(opts.legacyTimestampOnly ? {} : { analysisTasksSpawned: [] as string[] }),
    ...(opts.attempts ? { analysisRespawnAttempts: opts.attempts } : {}),
  };
  const wu = await wuService.create({
    type: 'analysis', scope: '分析需求：测试', channelId: 'ch-test', status: 'done', metadata,
  });
  const spawnedIds: string[] = [];
  for (const scope of opts.childScopes ?? []) {
    const child = await wuService.create({
      type: 'task', scope, channelId: 'ch-test', parentId: wu.id,
      status: opts.childStatus ?? 'unassigned',
    });
    spawnedIds.push(child.id);
  }
  if (!opts.legacyTimestampOnly && spawnedIds.length > 0) {
    await fileStore.updateMetadata(wu.id, latest => ({ ...latest, analysisTasksSpawned: spawnedIds }));
  }
  return wu;
}

async function createInReviewParent(opts: {
  type?: string;
  ageMin?: number;
  attempts?: number;
  withReviewChild?: boolean;
}): Promise<WorkUnitData> {
  const wu = await wuService.create({
    type: opts.type ?? 'task', scope: '实现某功能', channelId: 'ch-test', status: 'in_review',
    metadata: opts.attempts ? { reviewRedispatchAttempts: opts.attempts } : {},
  });
  if (opts.withReviewChild) {
    await wuService.create({
      type: 'review', scope: '审查代码变更', channelId: 'ch-test', parentId: wu.id, status: 'unassigned',
    });
  }
  await backdateUpdatedAt(wu.id, minutesAgo(opts.ageMin ?? 15));
  return wu;
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-reconciliation-'));
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  process.env.STUDIO_EVENTS_FILE = eventsFile;
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  await fileStore.createChannel({
    id: 'ch-test',
    name: '#test',
    type: 'rnd',
    defaultWorkspaceId: null,
    defaultPath: null,
    discordChannelId: null,
    discordWebhookUrl: null,
    members: '[]',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  });
});

afterEach(() => {
  delete process.env.STUDIO_EVENTS_FILE;
  eventBus.unsubscribeAll?.('workunit.status_changed');
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('#183 analysis 侧：哨兵清单化 + 对账补差集', () => {
  it('spawnTasks 落清单哨兵：analysisTasksSpawned 记已建子 WU id', async () => {
    const handoff = new AnalysisHandoff(fileStore, wuService);
    handoff.subscribeToEvents();
    const wu = await wuService.create({
      type: 'analysis', scope: '分析', channelId: 'ch-test', status: 'active',
      metadata: { analysisTasks: ['任务一', '任务二'] },
    });
    eventBus.publish('workunit.status_changed', { workunit: { ...wu, status: 'done' } });

    const deadline = Date.now() + 3000;
    let meta: WorkUnitMetadata = {};
    while (Date.now() < deadline) {
      meta = await readMeta(wu.id);
      if (Array.isArray(meta.analysisTasksSpawned) && meta.analysisTasksSpawned.length === 2) break;
      await new Promise(r => setTimeout(r, 20));
    }
    expect(meta.analysisTasksSpawnedAt).toBeTruthy();
    expect(meta.analysisTasksSpawned).toHaveLength(2);
    const children = await childrenOf(wu.id);
    expect(children.map(c => c.id).sort()).toEqual([...meta.analysisTasksSpawned!].sort());
  });

  it('断链自愈：清单缺 B → 补建 B，analysis.respawned warning 走告警管线', async () => {
    const wu = await createAnalysisWithSentinel({ tasks: ['任务A', '任务B'], childScopes: ['任务A'] });

    const result = await reconcileDispatchBreaks(fileStore);

    expect(result.analysis.respawned).toBe(1);
    const children = await childrenOf(wu.id);
    expect(children.map(c => c.scope).sort()).toEqual(['任务A', '任务B']);
    const childB = children.find(c => c.scope === '任务B')!;
    expect(childB.status).toBe('unassigned');
    const meta = await readMeta(wu.id);
    expect(meta.analysisTasksSpawned).toHaveLength(2);
    expect(meta.analysisTasksSpawned).toContain(childB.id);

    const events = await eventsOfType('analysis.respawned');
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('warning');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0][0].level).toBe('warning');
  });

  it('人工关单不复活：已关闭子 WU 仍在清单中 → 不认作缺失', async () => {
    const wu = await createAnalysisWithSentinel({
      tasks: ['任务A'], childScopes: ['任务A'], childStatus: 'closed',
    });

    const result = await reconcileDispatchBreaks(fileStore);

    expect(result.analysis.respawned).toBe(0);
    expect(await childrenOf(wu.id)).toHaveLength(1); // 没有新建
    expect(await eventsOfType('analysis.respawned')).toHaveLength(0);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('活体去重：create 成功但清单落档失败的窗口——按 parentId+scope 认养，不重复建单', async () => {
    const wu = await createAnalysisWithSentinel({ tasks: ['任务A', '任务B'], childScopes: ['任务A'] });
    // 模拟极端窗口：B 的子 WU 已建但 id 未入清单
    const orphanB = await wuService.create({
      type: 'task', scope: '任务B', channelId: 'ch-test', parentId: wu.id, status: 'unassigned',
    });

    await reconcileDispatchBreaks(fileStore);

    const children = await childrenOf(wu.id);
    expect(children).toHaveLength(2); // 未新建第三个
    const meta = await readMeta(wu.id);
    expect(meta.analysisTasksSpawned).toContain(orphanB.id); // 认养入清单
  });

  it('旧时间戳哨兵兼容：无清单（仅 analysisTasksSpawnedAt）→ 跳过不对账', async () => {
    const wu = await createAnalysisWithSentinel({ tasks: ['任务A'], legacyTimestampOnly: true });

    const result = await reconcileDispatchBreaks(fileStore);

    expect(result.analysis.scanned).toBe(0);
    expect(await childrenOf(wu.id)).toHaveLength(0);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('10min 宽限：哨兵落档 <10min 不参与对账（避开在飞 spawn）', async () => {
    const wu = await createAnalysisWithSentinel({ tasks: ['任务A'], sentinelAgeMin: 5 });

    const result = await reconcileDispatchBreaks(fileStore);

    expect(result.analysis.scanned).toBe(0);
    expect(await childrenOf(wu.id)).toHaveLength(0);
  });

  it('重试上限：补建失败记尝试数，3 次仍败停跑并升 critical', async () => {
    const wu = await createAnalysisWithSentinel({
      tasks: ['任务A'], attempts: MAX_RECONCILE_ATTEMPTS - 1,
    });
    const spy = vi.spyOn(WorkUnitService.prototype, 'create').mockRejectedValue(new Error('disk full'));

    await reconcileDispatchBreaks(fileStore);

    // 第 3 次失败 → critical + 停跑标记
    let meta = await readMeta(wu.id);
    expect(meta.analysisRespawnAttempts).toBe(MAX_RECONCILE_ATTEMPTS);
    let events = await eventsOfType('analysis.respawned');
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('critical');
    expect(mockDispatch.mock.calls[0][0][0].level).toBe('critical');

    // 停跑：后续扫描不再尝试（create 不再被调用、不再刷告警）
    spy.mockClear();
    mockDispatch.mockClear();
    const result = await reconcileDispatchBreaks(fileStore);
    expect(spy).not.toHaveBeenCalled();
    expect(result.analysis.respawned).toBe(0);
    expect(await eventsOfType('analysis.respawned')).toHaveLength(1); // 不新增
    meta = await readMeta(wu.id);
    expect(meta.analysisRespawnAttempts).toBe(MAX_RECONCILE_ATTEMPTS);
  });

  it('补建失败但未达上限：warning + 尝试数递增，下轮继续', async () => {
    const wu = await createAnalysisWithSentinel({ tasks: ['任务A'] });
    vi.spyOn(WorkUnitService.prototype, 'create').mockRejectedValue(new Error('disk full'));

    await reconcileDispatchBreaks(fileStore);

    const meta = await readMeta(wu.id);
    expect(meta.analysisRespawnAttempts).toBe(1);
    const events = await eventsOfType('analysis.respawned');
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('warning');
  });
});

describe('#183 review 侧：in_review 断链对账重跑', () => {
  it('父 WU in_review ≥10min 且无 review 子 WU → 幂等重跑建评审子单 + review.redispatched warning', async () => {
    const parent = await createInReviewParent({});

    const result = await reconcileDispatchBreaks(fileStore);

    expect(result.review.redispatched).toBe(1);
    const children = await childrenOf(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].type).toBe('review');
    expect(children[0].status).toBe('unassigned');
    const events = await eventsOfType('review.redispatched');
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('warning');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0][0].source).toBe('review_redispatch');
  });

  it('已有未完结 review 子 WU → 跳过（同父唯一性）', async () => {
    const parent = await createInReviewParent({ withReviewChild: true });

    const result = await reconcileDispatchBreaks(fileStore);

    expect(result.review.redispatched).toBe(0);
    expect(await childrenOf(parent.id)).toHaveLength(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('in_review <10min → 宽限跳过', async () => {
    const parent = await createInReviewParent({ ageMin: 5 });

    const result = await reconcileDispatchBreaks(fileStore);

    expect(result.review.scanned).toBe(0);
    expect(await childrenOf(parent.id)).toHaveLength(0);
  });

  it('analysis/decision 类父 WU 不进 review 对账（验收闸是人工）', async () => {
    const analysisParent = await createInReviewParent({ type: 'analysis' });
    const decisionParent = await createInReviewParent({ type: 'decision' });

    const result = await reconcileDispatchBreaks(fileStore);

    expect(result.review.redispatched).toBe(0);
    expect(await childrenOf(analysisParent.id)).toHaveLength(0);
    expect(await childrenOf(decisionParent.id)).toHaveLength(0);
  });

  it('review 重跑失败记尝试数，达上限停跑升 critical', async () => {
    const parent = await createInReviewParent({ attempts: MAX_RECONCILE_ATTEMPTS - 1 });
    const spy = vi.spyOn(WorkUnitService.prototype, 'createGuarded').mockRejectedValue(new Error('lock timeout'));

    await reconcileDispatchBreaks(fileStore);

    const meta = await readMeta(parent.id);
    expect(meta.reviewRedispatchAttempts).toBe(MAX_RECONCILE_ATTEMPTS);
    const events = await eventsOfType('review.redispatched');
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('critical');

    spy.mockClear();
    mockDispatch.mockClear();
    await reconcileDispatchBreaks(fileStore);
    expect(spy).not.toHaveBeenCalled(); // 停跑
  });
});
