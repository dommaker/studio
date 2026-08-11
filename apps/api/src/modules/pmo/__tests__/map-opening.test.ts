/**
 * MapOpening 单测（#112 T6：开图机制）
 *
 * 覆盖（issue 验收 + 边界）：
 *  - analysis 单 reviewPassed（done）且人工确认文本含待决问题清单 → 初始化 map
 *    （destination + fog 逐条）+ 逐条建未指派 decision 单（数量 = 雾条数）
 *    + 互挂：fog[].wuId = 新建 WU id，decision WU metadata 带 pmoId/fogId（#110 消费契约）
 *  - 幂等：同一 analysis WU 重复 done 事件不重复初始化 map/重复建 decision 单（mapOpenedAt 哨兵）
 *  - 无待决问题清单（无 FOG 行/无 summary）：不炸、不初始化；后续人工确认补填仍可开图
 *  - 已有 map 的 PMO：不重建、不新建 decision 单
 *  - DESTINATION 缺省 → 回退项目 title；非 analysis / 非 done：忽略
 *
 * 约定同 decision-resolution.test.ts：PMO 项目写真实 ~/.studio/projects，afterEach 统一删除。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service.js';
import { projectService, PROJECT_STATUS, type ProjectData } from '../project.service.js';
import { MapOpening } from '../map-opening.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let opening: MapOpening;
const createdProjectIds: string[] = [];

function metaOf(raw: string | null): WorkUnitMetadata {
  return raw ? JSON.parse(raw) as WorkUnitMetadata : {};
}

/** 轮询直至条件满足（事件订阅是 fire-and-forget） */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

async function createProject(): Promise<ProjectData> {
  const project = await projectService.create({
    title: `t6-opening-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  createdProjectIds.push(project.id);
  return (await projectService.get(project.id))!;
}

function l3(summary?: string): WorkUnitMetadata['attestations'] {
  return {
    l3: {
      verdict: 'approved',
      by: 'tester',
      at: '2026-08-11T00:00:00Z',
      kind: 'human-confirm',
      ...(summary !== undefined ? { summary } : {}),
    },
  };
}

async function createAnalysisWu(project: ProjectData, summary?: string): Promise<WorkUnitData> {
  return wuService.create({
    type: 'analysis',
    scope: `分析需求 ${project.pmoNumber}: ${project.title}`,
    channelId: 'ch-test',
    status: 'in_review',
    metadata: {
      pmoId: project.id,
      pmoNumber: project.pmoNumber,
      attestations: l3(summary),
    },
  });
}

async function emitDone(wu: WorkUnitData) {
  eventBus.publish('workunit.status_changed', { workunit: { ...wu, status: 'done' } });
}

async function decisionWus(): Promise<Array<{ id: string; status: string; metadata: WorkUnitMetadata }>> {
  return (await fileStore.getIndex())
    .filter(s => s.type === 'decision')
    .map(s => ({ id: s.id, status: s.status, metadata: metaOf(s.metadata) }));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-opening-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  eventBus.unsubscribeAll?.('workunit.status_changed');
  opening = new MapOpening(fileStore, wuService);
  opening.subscribeToEvents();

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

afterEach(async () => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const id of createdProjectIds.splice(0)) {
    await projectService.update(id, { status: PROJECT_STATUS.PENDING }).catch(() => {});
    await projectService.delete(id).catch(() => { /* 忽略 */ });
  }
});

describe('MapOpening（#112 开图机制）', () => {
  it('开图通过 → map 初始化 + 决策单数 = 雾条数 + wuId 互挂正确', async () => {
    const project = await createProject();
    const wu = await createAnalysisWu(project, 'DESTINATION: 把 X 做起来\nFOG: 存储选型？\nFOG: 部署形态？');

    // map 先初始化、decision 单后建、wuId 最后回写——以回写完成作为就绪条件
    const mapReady = async () => {
      const m = (await projectService.get(project.id))!.map;
      return !!m && m.fog.length === 2 && m.fog.every(f => !!f.wuId);
    };
    await emitDone(wu);
    const ok = await waitFor(mapReady);
    expect(ok).toBe(true);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.destination).toBe('把 X 做起来');
    expect(map.decisions).toEqual([]);
    expect(map.fog.length).toBe(2);
    expect(map.fog.map(f => f.question)).toEqual(['存储选型？', '部署形态？']);
    expect(map.fog.every(f => f.status === 'open')).toBe(true);

    const decisions = await decisionWus();
    expect(decisions.length).toBe(2);
    expect(decisions.every(d => d.status === 'unassigned')).toBe(true);

    // 互挂：decision WU metadata 带 pmoId/fogId（#110 消费），fog[].wuId = 新建 WU id
    for (const fogItem of map.fog) {
      expect(fogItem.wuId).toBeTruthy();
      const decision = decisions.find(d => d.id === fogItem.wuId);
      expect(decision).toBeDefined();
      expect(decision!.metadata.pmoId).toBe(project.id);
      expect(decision!.metadata.pmoNumber).toBe(project.pmoNumber);
      expect(decision!.metadata.fogId).toBe(fogItem.id);
    }

    // 幂等哨兵落档
    expect(metaOf((await wuService.getById(wu.id))!.metadata).mapOpenedAt).toBeTruthy();
  });

  it('幂等：同一 analysis WU 重复 done 事件不重复初始化 map/重复建 decision 单', async () => {
    const project = await createProject();
    const wu = await createAnalysisWu(project, 'FOG: 存储选型？\nFOG: 部署形态？');

    await emitDone(wu);
    await waitFor(async () => {
      const m = (await projectService.get(project.id))!.map;
      return !!m && m.fog.every(f => !!f.wuId);
    });
    const mapBefore = (await projectService.get(project.id))!.map!;

    await emitDone(wu);
    await new Promise(r => setTimeout(r, 150));

    expect((await decisionWus()).length).toBe(2);
    expect((await projectService.get(project.id))!.map!.fog).toEqual(mapBefore.fog);
  });

  it('DESTINATION 缺省 → destination 回退项目 title；兼容中文冒号', async () => {
    const project = await createProject();
    const wu = await createAnalysisWu(project, 'FOG：存储选型？');

    await emitDone(wu);
    const ok = await waitFor(async () => (await decisionWus()).length === 1);
    expect(ok).toBe(true);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.destination).toBe(project.title);
    expect(map.fog[0].question).toBe('存储选型？');
  });

  it('无待决问题清单（无 FOG 行）：不炸、不初始化、不落哨兵', async () => {
    const project = await createProject();
    const wu = await createAnalysisWu(project, '结论没问题，可以开工');

    await emitDone(wu);
    await new Promise(r => setTimeout(r, 150));

    expect((await projectService.get(project.id))!.map).toBeFalsy();
    expect((await decisionWus()).length).toBe(0);
    expect(metaOf((await wuService.getById(wu.id))!.metadata).mapOpenedAt).toBeUndefined();
  });

  it('无待决问题清单首开不动；后续人工确认补填 FOG 清单仍可开图', async () => {
    const project = await createProject();
    const wu = await createAnalysisWu(project); // 无 summary

    await emitDone(wu);
    await new Promise(r => setTimeout(r, 150));
    expect((await projectService.get(project.id))!.map).toBeFalsy();

    // F6-b：done 后人工补确认（l3 覆写）仍发 status_changed(done) —— 补填清单应能开图
    const fresh = (await wuService.getById(wu.id))!;
    const meta = metaOf(fresh.metadata);
    await wuService.update(wu.id, {
      metadata: { ...meta, attestations: l3('FOG: 存储选型？') },
    });
    await emitDone((await wuService.getById(wu.id))!);

    const ok = await waitFor(async () => (await decisionWus()).length === 1);
    expect(ok).toBe(true);
    expect((await projectService.get(project.id))!.map!.fog.length).toBe(1);
  });

  it('已有 map 的 PMO：不重建、不新建 decision 单', async () => {
    const project = await createProject();
    await projectService.update(project.id, {
      map: {
        destination: '老目的地',
        decisions: [],
        fog: [{ id: 'fog-old', question: '老问题', wuId: null, status: 'open' }],
      },
    });
    const wu = await createAnalysisWu(project, 'FOG: 新问题？');

    await emitDone(wu);
    await new Promise(r => setTimeout(r, 150));

    const map = (await projectService.get(project.id))!.map!;
    expect(map.destination).toBe('老目的地');
    expect(map.fog.length).toBe(1);
    expect(map.fog[0].id).toBe('fog-old');
    expect((await decisionWus()).length).toBe(0);
  });

  it('非 PMO analysis（缺 pmoId）/ 非 analysis 类型 / 非 done 状态：忽略', async () => {
    const project = await createProject();
    const noPmo = await wuService.create({
      type: 'analysis',
      scope: '无 PMO 分析',
      channelId: 'ch-test',
      status: 'in_review',
      metadata: { attestations: l3('FOG: 存储选型？') },
    });
    await emitDone(noPmo);

    const wu = await createAnalysisWu(project, 'FOG: 存储选型？');
    eventBus.publish('workunit.status_changed', { workunit: { ...wu, status: 'in_review' } });
    eventBus.publish('workunit.status_changed', { workunit: { ...wu, type: 'task', status: 'done' } });
    await new Promise(r => setTimeout(r, 150));

    expect((await projectService.get(project.id))!.map).toBeFalsy();
    expect((await decisionWus()).length).toBe(0);
  });
});
