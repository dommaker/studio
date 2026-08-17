/**
 * #163（T8-E2，#130 决策 4/5）：inspection-scan 事件闸测试——
 * bug 关闭累计计数（可配可关）+ 冷却去重 + scheduler 接线（事件触发先过冷却闸）。
 *
 * 手动 fire 不走本闸（直调 executeCreateAction），其「绕过冷却」断言在
 * trigger-fire.routes.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, StudioEventBus, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { TriggerScheduler } from '../trigger-scheduler';
import { setTriggerActionFileStore } from '../trigger-action';
import {
  evaluateInspectionEvent, checkInspectionCooldown, resolveInspectionScanThreshold,
  INSPECTION_SCAN_TRIGGER_ID, DEFAULT_INSPECTION_SCAN_THRESHOLD,
} from '../inspection-scan';
import { WorkUnitService } from '../../workunit/workunit.service';
import { readStudioEvents } from '../../../utils/studio-events';
import type { TriggerConfig } from '../trigger.types';

let tmpDir: string;
let store: FileStore;
let eventsFile: string;

function makeSnapshot(over: Partial<WorkUnitSnapshot>): WorkUnitSnapshot {
  return {
    id: over.id ?? `wu-${Math.random().toString(36).slice(2, 10)}`,
    parentId: null,
    type: 'task',
    scope: 'scope',
    assigneeId: null,
    status: 'unassigned',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    projectPath: null,
    metadata: null,
    createdAt: '2026-08-15T10:00:00.000Z',
    updatedAt: '2026-08-15T10:00:00.000Z',
    claimedAt: null,
    completedAt: null,
    ...over,
  };
}

function closedBug(id: string, updatedAt: string): WorkUnitSnapshot {
  return makeSnapshot({ id, type: 'bug', status: 'closed', updatedAt });
}

function inspectionWu(id: string, createdAt: string, opportunities: unknown): WorkUnitSnapshot {
  return makeSnapshot({
    id,
    type: 'analysis',
    status: 'in_review',
    createdAt,
    metadata: JSON.stringify({ inspection: true, opportunities }),
  });
}

const PENDING_OPP = { id: 'opp-1', problem: 'p', suggestion: 's', status: 'pending' };
const ADOPTED_OPP = { id: 'opp-1', problem: 'p', suggestion: 's', status: 'adopted', wuId: 'wu-x' };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspection-scan-test-'));
  store = new FileStore(tmpDir);
  setTriggerActionFileStore(store);
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  process.env.STUDIO_EVENTS_FILE = eventsFile;
  delete process.env.INSPECTION_SCAN_THRESHOLD;
});

afterEach(() => {
  delete process.env.STUDIO_EVENTS_FILE;
  delete process.env.INSPECTION_SCAN_THRESHOLD;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveInspectionScanThreshold（N 可配可关）', () => {
  it('缺省 = 3；合法覆盖生效；非法值回落默认；<=0 = 关闭事件触发', () => {
    expect(resolveInspectionScanThreshold({})).toBe(DEFAULT_INSPECTION_SCAN_THRESHOLD);
    expect(resolveInspectionScanThreshold({ INSPECTION_SCAN_THRESHOLD: '5' })).toBe(5);
    expect(resolveInspectionScanThreshold({ INSPECTION_SCAN_THRESHOLD: 'abc' })).toBe(DEFAULT_INSPECTION_SCAN_THRESHOLD);
    expect(resolveInspectionScanThreshold({ INSPECTION_SCAN_THRESHOLD: '0' })).toBe(0);
    expect(resolveInspectionScanThreshold({ INSPECTION_SCAN_THRESHOLD: '-2' })).toBe(-2);
  });
});

describe('evaluateInspectionEvent（闸判定链）', () => {
  const bugClosedPayload = { workunit: { id: 'wu-b', type: 'bug', status: 'closed' } };

  it('非 bug 关闭事件 → not-bug-closed（忽略）', async () => {
    expect(await evaluateInspectionEvent({ workunit: { type: 'task', status: 'closed' } }, store))
      .toEqual({ fire: false, reason: 'not-bug-closed' });
    expect(await evaluateInspectionEvent({ workunit: { type: 'bug', status: 'done' } }, store))
      .toEqual({ fire: false, reason: 'not-bug-closed' });
    expect(await evaluateInspectionEvent({}, store))
      .toEqual({ fire: false, reason: 'not-bug-closed' });
  });

  it('阈值 <=0 → disabled（累计多少 bug 都不触发）', async () => {
    for (let i = 0; i < 10; i++) await store.upsertSnapshot(closedBug(`b${i}`, '2026-08-15T11:00:00.000Z'));
    expect(await evaluateInspectionEvent(bugClosedPayload, store, { INSPECTION_SCAN_THRESHOLD: '0' }))
      .toEqual({ fire: false, reason: 'disabled' });
  });

  it('未达阈值 → below-threshold', async () => {
    await store.upsertSnapshot(closedBug('b1', '2026-08-15T11:00:00.000Z'));
    await store.upsertSnapshot(closedBug('b2', '2026-08-15T11:01:00.000Z'));
    expect(await evaluateInspectionEvent(bugClosedPayload, store))
      .toEqual({ fire: false, reason: 'below-threshold' });
  });

  it('无历史巡检单 + 累计达阈值 → fire（无历史单放行）', async () => {
    for (let i = 0; i < 3; i++) await store.upsertSnapshot(closedBug(`b${i}`, '2026-08-15T11:00:00.000Z'));
    expect(await evaluateInspectionEvent(bugClosedPayload, store)).toEqual({ fire: true });
  });

  it('计数只算最近巡检单创建之后关闭的 bug（建单即归零）', async () => {
    // 3 个 bug 在巡检单之前关闭（不计），之后只有 2 个（未达阈值）
    for (let i = 0; i < 3; i++) await store.upsertSnapshot(closedBug(`old${i}`, '2026-08-15T09:00:00.000Z'));
    await store.upsertSnapshot(inspectionWu('insp-1', '2026-08-15T10:00:00.000Z', [ADOPTED_OPP]));
    await store.upsertSnapshot(closedBug('new1', '2026-08-15T11:00:00.000Z'));
    await store.upsertSnapshot(closedBug('new2', '2026-08-15T11:01:00.000Z'));
    expect(await evaluateInspectionEvent(bugClosedPayload, store))
      .toEqual({ fire: false, reason: 'below-threshold' });
    // 再关 1 个 → 达阈值且最近单无待处理条目 → fire
    await store.upsertSnapshot(closedBug('new3', '2026-08-15T11:02:00.000Z'));
    expect(await evaluateInspectionEvent(bugClosedPayload, store)).toEqual({ fire: true });
  });

  it('冷却：最近巡检单有待处理条目 → cooldown（含待处理条数）', async () => {
    await store.upsertSnapshot(inspectionWu('insp-1', '2026-08-15T10:00:00.000Z', [PENDING_OPP, ADOPTED_OPP]));
    for (let i = 0; i < 5; i++) await store.upsertSnapshot(closedBug(`b${i}`, '2026-08-15T11:00:00.000Z'));
    expect(await evaluateInspectionEvent(bugClosedPayload, store)).toEqual({
      fire: false, reason: 'cooldown', pendingCount: 1, latestWuId: 'insp-1',
    });
  });

  it('阈值可配：INSPECTION_SCAN_THRESHOLD=2 时 2 个 bug 即达线', async () => {
    await store.upsertSnapshot(closedBug('b1', '2026-08-15T11:00:00.000Z'));
    await store.upsertSnapshot(closedBug('b2', '2026-08-15T11:01:00.000Z'));
    expect(await evaluateInspectionEvent(bugClosedPayload, store, { INSPECTION_SCAN_THRESHOLD: '2' }))
      .toEqual({ fire: true });
  });
});

describe('checkInspectionCooldown（SCHEDULE 路径共用）', () => {
  it('无历史单 → 放行；有待处理条目 → skip；全部已处置 → 放行', async () => {
    expect((await checkInspectionCooldown(store)).skip).toBe(false);

    await store.upsertSnapshot(inspectionWu('insp-1', '2026-08-15T10:00:00.000Z', [PENDING_OPP]));
    const hit = await checkInspectionCooldown(store);
    expect(hit).toEqual({ skip: true, pendingCount: 1, latestWuId: 'insp-1' });

    await store.upsertSnapshot(inspectionWu('insp-2', '2026-08-15T12:00:00.000Z', [ADOPTED_OPP]));
    expect((await checkInspectionCooldown(store)).skip).toBe(false);
  });
});

describe('scheduler 接线：事件触发先过冷却闸', () => {
  let bus: StudioEventBus;
  let scheduler: TriggerScheduler;

  const triggerConfig: TriggerConfig = {
    id: INSPECTION_SCAN_TRIGGER_ID,
    name: 'Inspection scan',
    condition: { type: 'EVENT', event: 'workunit.status_changed' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: { type: 'analysis', scope: '巡检', metadata: { inspection: true } },
    },
    enabled: true,
    scope: 'system',
  };

  const settle = () => new Promise(r => setTimeout(r, 50));
  const publishBugClosed = () =>
    bus.publish('workunit.status_changed', { workunit: { id: 'evt-b', type: 'bug', status: 'closed' } });
  const createdInspectionWus = async () =>
    (await store.getIndex()).filter(s => s.metadata?.includes('"inspection":true'));

  beforeEach(() => {
    bus = new StudioEventBus();
    scheduler = new TriggerScheduler({ store: null, eventBus: bus });
    scheduler.registerTrigger(triggerConfig);
  });

  afterEach(() => {
    scheduler.dispose();
  });

  it('达阈值且无待处理条目 → 建巡检单（analysis + inspection 标记 + pending 人闸）', async () => {
    for (let i = 0; i < 3; i++) await store.upsertSnapshot(closedBug(`b${i}`, '2026-08-15T11:00:00.000Z'));
    publishBugClosed();
    await settle();

    const created = await createdInspectionWus();
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe('analysis');
    expect(created[0].status).toBe('pending'); // #162 人闸：触发器建单统一落 pending
  });

  it('冷却命中 → 跳过建单，落 studio-events 留痕（含待处理条数）', async () => {
    await store.upsertSnapshot(inspectionWu('insp-1', '2026-08-15T10:00:00.000Z', [PENDING_OPP, PENDING_OPP]));
    for (let i = 0; i < 3; i++) await store.upsertSnapshot(closedBug(`b${i}`, '2026-08-15T11:00:00.000Z'));
    publishBugClosed();
    await settle();

    expect(await createdInspectionWus()).toHaveLength(1); // 只有手动播种的历史单
    const events = (await readStudioEvents({ file: eventsFile }))
      .filter(e => e.type === 'trigger:inspection_scan_skipped');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload as string);
    expect(payload).toMatchObject({
      triggerId: INSPECTION_SCAN_TRIGGER_ID,
      reason: 'cooldown',
      pendingCount: 2,
      latestWuId: 'insp-1',
    });
  });

  it('未达阈值 → 不建单也不留痕（静默）', async () => {
    await store.upsertSnapshot(closedBug('b1', '2026-08-15T11:00:00.000Z'));
    publishBugClosed();
    await settle();

    expect(await createdInspectionWus()).toHaveLength(0);
    expect((await readStudioEvents({ file: eventsFile }))).toHaveLength(0);
  });

  it('INSPECTION_SCAN_THRESHOLD=0 → 事件触发整体关闭', async () => {
    process.env.INSPECTION_SCAN_THRESHOLD = '0';
    for (let i = 0; i < 9; i++) await store.upsertSnapshot(closedBug(`b${i}`, '2026-08-15T11:00:00.000Z'));
    publishBugClosed();
    await settle();

    expect(await createdInspectionWus()).toHaveLength(0);
  });

  it('触发器 enabled=false → 不过闸不建单', async () => {
    scheduler.registerTrigger({ ...triggerConfig, enabled: false });
    for (let i = 0; i < 3; i++) await store.upsertSnapshot(closedBug(`b${i}`, '2026-08-15T11:00:00.000Z'));
    publishBugClosed();
    await settle();

    expect(await createdInspectionWus()).toHaveLength(0);
  });

  it('createdInspectionWus 辅助：建单 metadata 含 triggerId 留痕', async () => {
    for (let i = 0; i < 3; i++) await store.upsertSnapshot(closedBug(`b${i}`, '2026-08-15T11:00:00.000Z'));
    publishBugClosed();
    await settle();

    const wuService = new WorkUnitService(store);
    const list = await wuService.list({ type: 'analysis' });
    expect(list.data).toHaveLength(1);
    const meta = JSON.parse(list.data[0].metadata!);
    expect(meta.triggerId).toBe(INSPECTION_SCAN_TRIGGER_ID);
    expect(meta.inspection).toBe(true);
  });
});
