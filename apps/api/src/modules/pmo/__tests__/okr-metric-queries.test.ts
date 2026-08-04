// OKRMetricQueries 直接单元测试（B8 数据源查询层，从 okr.service.ts 拆出）
// 覆盖：readEvents 行解析/容错、checkDataSourceHealth 有无数据分支、
// 代表性 query* 方法（时间窗过滤 / 类型计数 / 聚合口径）。
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { FileStore } from '@dommaker/studio-shared';
import type { WorkUnitSnapshot } from '@dommaker/studio-shared';

// okr-metric-queries.ts 在模块加载时以 os.homedir() 固化 STUDIO_DIR 及各 jsonl
// 路径常量（不读 STUDIO_DATA_DIR，见 setup-isolated-data.setup.ts 的残余风险说明）。
// 与 resolution.service.test.ts 同款：vi.hoisted 建 tmp home + mock os.homedir()，
// 让被测模块 import 期与调用期解析到同一个 tmp 目录，任何 pool 下行为一致，
// 不触碰真实 ~/.studio。
const { tmpHome } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'okr-metric-queries-'));
  fs.mkdirSync(path.join(tmpHome, '.studio', 'logs'), { recursive: true });
  return { tmpHome };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => tmpHome;
  return {
    ...actual,
    homedir,
    default: { ...(actual as any).default ?? actual, homedir },
  };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => tmpHome;
  return {
    ...actual,
    homedir,
    default: { ...(actual as any).default ?? actual, homedir },
  };
});

import { OKRMetricQueries } from '../okr-metric-queries.js';
import type { StudioEventRow } from '../okr-metric-queries.js';

// 被测模块常量（os.homedir() 已被 mock 指向 tmpHome）对应的 fixture 路径
const LOGS_DIR = path.join(tmpHome, '.studio', 'logs');
const EVENTS_FILE = path.join(LOGS_DIR, 'studio-events.jsonl');
const INCIDENTS_FILE = path.join(LOGS_DIR, 'incidents.jsonl');

const DAY_MS = 86400000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

/** 覆盖写 jsonl fixture；string 元素原样落盘（用于构造坏行/异形行） */
function writeJsonl(filePath: string, rows: unknown[]): void {
  const content = rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  fs.writeFileSync(filePath, content ? content + '\n' : '', 'utf-8');
}

/** 每个用例独立的 FileStore 数据根（WorkUnit index 互相隔离），afterAll 统一清理 */
const storeDirs: string[] = [];
function makeQueries(): { queries: TestOKRMetricQueries; fileStore: FileStore } {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okr-mq-store-'));
  storeDirs.push(storeDir);
  const fileStore = new FileStore(storeDir);
  return { queries: new TestOKRMetricQueries(fileStore), fileStore };
}

/** 创建 WorkUnitSnapshot 并写入 FileStore（与 okr-b8.test.ts 同款 fixture） */
async function seedWorkUnit(fileStore: FileStore, overrides: Partial<WorkUnitSnapshot>): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const now = new Date().toISOString();
  const snapshot: WorkUnitSnapshot = {
    id,
    parentId: null,
    type: 'task',
    scope: 'seed',
    assigneeId: null,
    status: 'unassigned',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    projectPath: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    claimedAt: null,
    completedAt: null,
    ...overrides,
  };
  await fileStore.upsertSnapshot(snapshot);
  return id;
}

/** 暴露 protected/private 成员的测试子类（不改变被测行为） */
class TestOKRMetricQueries extends OKRMetricQueries {
  callReadEvents(type: string, since: Date): Promise<StudioEventRow[]> {
    return (this as unknown as {
      readEvents(t: string, s: Date): Promise<StudioEventRow[]>;
    }).readEvents(type, since);
  }
  callQueryExecutionSuccessRate(days: number) { return this.queryExecutionSuccessRate(days); }
  callQueryReviewPassRate(days: number) { return this.queryReviewPassRate(days); }
  callQueryIncidentCount(days: number) { return this.queryIncidentCount(days); }
  callQueryDeploySuccessRate(days: number) { return this.queryDeploySuccessRate(days); }
  callQueryDeployFailureRate(days: number) { return this.queryDeployFailureRate(days); }
  callQueryKnowledgeSearchHitRate(days: number) { return this.queryKnowledgeSearchHitRate(days); }
}

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  for (const dir of storeDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('OKRMetricQueries.readEvents', () => {
  it('filters by type and time window; tolerates corrupt lines and legacy timestamp', async () => {
    const { queries } = makeQueries();
    writeJsonl(EVENTS_FILE, [
      { type: 'deploy.completed', createdAt: isoDaysAgo(1), payload: '{}' },   // 命中
      { type: 'deploy.completed', timestamp: isoDaysAgo(2) },                  // 命中（legacy ISO timestamp）
      { type: 'deploy.completed', timestamp: Date.now() - 3 * DAY_MS },        // 命中（legacy epoch number）
      { type: 'deploy.completed', createdAt: isoDaysAgo(30) },                 // 时间窗外
      { type: 'knowledge:search', createdAt: isoDaysAgo(1) },                  // type 不匹配
      { type: 'deploy.completed' },                                            // 无时间字段（NaN）
      '{corrupt-json-line',                                                    // 坏行 → 跳过
      '42',                                                                    // 合法 JSON 但非事件对象 → 过滤掉
    ]);
    const rows = await queries.callReadEvents('deploy.completed', new Date(Date.now() - 7 * DAY_MS));
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.type === 'deploy.completed')).toBe(true);
  });

  it('returns empty array when events file does not exist', async () => {
    const { queries } = makeQueries();
    fs.rmSync(EVENTS_FILE, { force: true });
    await expect(queries.callReadEvents('deploy.completed', new Date(0))).resolves.toEqual([]);
  });

  it('returns empty array when events file is empty', async () => {
    const { queries } = makeQueries();
    fs.writeFileSync(EVENTS_FILE, '', 'utf-8');
    await expect(queries.callReadEvents('deploy.completed', new Date(0))).resolves.toEqual([]);
  });
});

describe('OKRMetricQueries.checkDataSourceHealth', () => {
  it('returns empty/empty when no events file and no workunits', async () => {
    const { queries } = makeQueries();
    fs.rmSync(EVENTS_FILE, { force: true });
    const health = await queries.checkDataSourceHealth();
    expect(health).toEqual({ studio_event: 'empty', execution: 'empty' });
  });

  it('treats events file with only corrupt lines as empty', async () => {
    const { queries } = makeQueries();
    writeJsonl(EVENTS_FILE, ['{broken', 'not json at all {']);
    const health = await queries.checkDataSourceHealth();
    expect(health.studio_event).toBe('empty');
    expect(health.execution).toBe('empty');
  });

  it('returns ok/empty when events exist but no workunits', async () => {
    const { queries } = makeQueries();
    writeJsonl(EVENTS_FILE, [{ type: 'knowledge:search', createdAt: isoDaysAgo(1) }]);
    const health = await queries.checkDataSourceHealth();
    expect(health.studio_event).toBe('ok');
    expect(health.execution).toBe('empty');
  });

  it('returns ok/ok when both sources have data', async () => {
    const { queries, fileStore } = makeQueries();
    writeJsonl(EVENTS_FILE, [{ type: 'knowledge:search', createdAt: isoDaysAgo(1) }]);
    await seedWorkUnit(fileStore, { status: 'done' });
    const health = await queries.checkDataSourceHealth();
    expect(health).toEqual({ studio_event: 'ok', execution: 'ok' });
  });
});

describe('OKRMetricQueries.queryExecutionSuccessRate', () => {
  async function seedExecStore(fileStore: FileStore): Promise<void> {
    await seedWorkUnit(fileStore, { status: 'done' });                              // 窗口内，成功
    await seedWorkUnit(fileStore, { status: 'closed' });                            // 窗口内，计入 total 不算成功
    await seedWorkUnit(fileStore, { status: 'active' });                            // 窗口内，计入 total 不算成功
    await seedWorkUnit(fileStore, { status: 'unassigned' });                        // 不计入 total
    await seedWorkUnit(fileStore, { status: 'done', createdAt: isoDaysAgo(40) });   // 7 天窗外
  }

  it('computes done/total within window, excluding unassigned', async () => {
    const { queries, fileStore } = makeQueries();
    await seedExecStore(fileStore);
    // total = done + closed + active = 3，succeeded = 1 → 33
    await expect(queries.callQueryExecutionSuccessRate(7)).resolves.toBe(33);
  });

  it('includes older snapshots when the window widens', async () => {
    const { queries, fileStore } = makeQueries();
    await seedExecStore(fileStore);
    // total = 4（含 40 天前的 done），succeeded = 2 → 50
    await expect(queries.callQueryExecutionSuccessRate(45)).resolves.toBe(50);
  });

  it('returns null when no eligible snapshots exist', async () => {
    const { queries, fileStore } = makeQueries();
    await seedWorkUnit(fileStore, { status: 'unassigned' }); // 唯一快照被口径排除
    await expect(queries.callQueryExecutionSuccessRate(7)).resolves.toBeNull();
  });
});

describe('OKRMetricQueries.queryReviewPassRate', () => {
  async function seedReviewStore(fileStore: FileStore): Promise<void> {
    await seedWorkUnit(fileStore, { status: 'done', metadata: JSON.stringify({ reviewScore: 80 }) });   // 通过
    await seedWorkUnit(fileStore, { status: 'closed', metadata: JSON.stringify({ reviewScore: 60 }) }); // 不通过
    await seedWorkUnit(fileStore, { status: 'done', metadata: JSON.stringify({ reviewScore: 70 }) });   // 边界 → 通过
    await seedWorkUnit(fileStore, { status: 'done', metadata: 'not-json{' });                           // 坏 metadata → 不计入
    await seedWorkUnit(fileStore, { status: 'done' });                                                  // 无 metadata → 不计入
    await seedWorkUnit(fileStore, { status: 'active', metadata: JSON.stringify({ reviewScore: 100 }) }); // 状态口径外
    await seedWorkUnit(fileStore, { status: 'done', createdAt: isoDaysAgo(40), metadata: JSON.stringify({ reviewScore: 100 }) }); // 7 天窗外
  }

  it('computes pass rate with reviewScore >= 70, skipping unparseable/missing metadata', async () => {
    const { queries, fileStore } = makeQueries();
    await seedReviewStore(fileStore);
    // withReview = 3（80/60/70），passed = 2 → 67；窗口拉宽后 40 天前的 100 分进入 → 3/4 = 75
    await expect(queries.callQueryReviewPassRate(7)).resolves.toBe(67);
    await expect(queries.callQueryReviewPassRate(45)).resolves.toBe(75);
  });

  it('returns null when no work unit has review data', async () => {
    const { queries, fileStore } = makeQueries();
    await seedWorkUnit(fileStore, { status: 'done' }); // done 但无 reviewScore
    await expect(queries.callQueryReviewPassRate(7)).resolves.toBeNull();
  });
});

describe('OKRMetricQueries.queryIncidentCount', () => {
  it('counts incidents by detectedAt within the window', async () => {
    const { queries } = makeQueries();
    writeJsonl(INCIDENTS_FILE, [
      { id: 'i1', detectedAt: isoDaysAgo(1) },    // 窗口内
      { id: 'i2', detectedAt: isoDaysAgo(30) },   // 7 天窗外 / 45 天窗内
      { id: 'i3' },                               // 无 detectedAt → 不计
      '{broken',                                  // 坏行 → 跳过
    ]);
    await expect(queries.callQueryIncidentCount(7)).resolves.toBe(1);
    await expect(queries.callQueryIncidentCount(45)).resolves.toBe(2);
  });

  it('returns 0 (not null) when incidents file does not exist', async () => {
    const { queries } = makeQueries();
    fs.rmSync(INCIDENTS_FILE, { force: true });
    await expect(queries.callQueryIncidentCount(7)).resolves.toBe(0);
  });
});

describe('OKRMetricQueries.queryDeploySuccessRate / queryDeployFailureRate', () => {
  function seedDeployEvents(): void {
    writeJsonl(EVENTS_FILE, [
      { type: 'deploy.completed', createdAt: isoDaysAgo(1), payload: JSON.stringify({ success: true }) },
      { type: 'deploy.completed', createdAt: isoDaysAgo(2), payload: JSON.stringify({ success: false }) },
      { type: 'deploy.completed', createdAt: isoDaysAgo(1), payload: JSON.stringify({ result: { success: true } }) },
      { type: 'deploy.completed', createdAt: isoDaysAgo(3), payload: JSON.stringify({ result: { success: false } }) },
      { type: 'deploy.completed', createdAt: isoDaysAgo(1), payload: '{corrupt-payload' }, // 分母计入，分子两边都不计
      { type: 'deploy.completed', createdAt: isoDaysAgo(30), payload: JSON.stringify({ success: true }) }, // 7 天窗外
      { type: 'other.event', createdAt: isoDaysAgo(1), payload: JSON.stringify({ success: true }) },       // type 口径外
    ]);
  }

  it('success rate: payload.success / payload.result.success, corrupt payload counts as failure', async () => {
    const { queries } = makeQueries();
    seedDeployEvents();
    // 窗口内 5 条（含坏 payload），成功 2 → 40；窗口拉宽后 6 条成功 3 → 50
    await expect(queries.callQueryDeploySuccessRate(7)).resolves.toBe(40);
    await expect(queries.callQueryDeploySuccessRate(45)).resolves.toBe(50);
  });

  it('failure rate: only explicit success === false counts as failure', async () => {
    const { queries } = makeQueries();
    seedDeployEvents();
    // 窗口内 5 条，显式失败 2（success:false + result.success:false；坏 payload 不算失败）→ 40
    // 窗口拉宽后 6 条失败 2 → 33
    await expect(queries.callQueryDeployFailureRate(7)).resolves.toBe(40);
    await expect(queries.callQueryDeployFailureRate(45)).resolves.toBe(33);
  });

  it('both rates return null when no deploy.completed events exist', async () => {
    const { queries } = makeQueries();
    writeJsonl(EVENTS_FILE, [{ type: 'other.event', createdAt: isoDaysAgo(1), payload: '{}' }]);
    await expect(queries.callQueryDeploySuccessRate(7)).resolves.toBeNull();
    await expect(queries.callQueryDeployFailureRate(7)).resolves.toBeNull();
  });
});

describe('OKRMetricQueries.queryKnowledgeSearchHitRate', () => {
  it('computes search_hit / search within the window', async () => {
    const { queries } = makeQueries();
    writeJsonl(EVENTS_FILE, [
      { type: 'knowledge:search', createdAt: isoDaysAgo(1) },
      { type: 'knowledge:search', createdAt: isoDaysAgo(2) },
      { type: 'knowledge:search', createdAt: isoDaysAgo(3) },
      { type: 'knowledge:search_hit', createdAt: isoDaysAgo(1) },
      { type: 'knowledge:search_hit', createdAt: isoDaysAgo(2) },
      { type: 'knowledge:search', createdAt: isoDaysAgo(30) },  // 7 天窗外
      { type: 'knowledge:search', createdAt: isoDaysAgo(30) },  // 7 天窗外
    ]);
    // 7 天窗：searches = 3，hits = 2 → 67；45 天窗：searches = 5，hits = 2 → 40
    await expect(queries.callQueryKnowledgeSearchHitRate(7)).resolves.toBe(67);
    await expect(queries.callQueryKnowledgeSearchHitRate(45)).resolves.toBe(40);
  });

  it('returns null when no search events exist', async () => {
    const { queries } = makeQueries();
    writeJsonl(EVENTS_FILE, [{ type: 'knowledge:search_hit', createdAt: isoDaysAgo(1) }]);
    await expect(queries.callQueryKnowledgeSearchHitRate(7)).resolves.toBeNull();
  });
});
