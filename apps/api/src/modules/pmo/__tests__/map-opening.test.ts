/**
 * MapOpening 单测（#112 T6：开图机制；#471 起降级为台账记录）
 *
 * #471（派生链收敛）行为变更：开图只初始化探路台账（project.map = destination + fog[]），
 * 不再逐条建 decision WU——裁决在 plan 一脉会话内进行（#467 会话内人闸），fog[].wuId 恒 null。
 *
 * 覆盖（issue 验收 + 边界）：
 *  - analysis/plan 单 reviewPassed（done）且人工确认文本含待决问题清单 → 初始化 map
 *    （destination + fog 逐条，wuId=null，status=open），不建 decision 单
 *  - 幂等：同一 WU 重复 done 事件不重复初始化 map（mapOpenedAt 哨兵）
 *  - 无待决问题清单（无 FOG 行/无 summary）：不炸、不初始化；后续人工确认补填仍可开图
 *  - 已有 map 的 PMO：不重建
 *  - DESTINATION 缺省 → 回退项目 title；非 analysis/plan / 非 done：忽略
 *
 * 约定同 decision-resolution.test.ts：PMO 项目经 projectService 写入（落 #219 setup 钉的
 * 隔离根 projects/，非真实 ~/.studio），afterEach 统一删除。
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

async function createPlanChainWu(project: ProjectData, summary?: string, type: 'analysis' | 'plan' = 'plan'): Promise<WorkUnitData> {
  return wuService.create({
    type,
    scope: `规划需求 ${project.pmoNumber}: ${project.title}`,
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

/** map 台账就绪条件：初始化完成（fog 条数对齐，wuId 恒 null——#471 不再互挂） */
async function mapReady(projectId: string, fogCount: number): Promise<boolean> {
  const m = (await projectService.get(projectId))!.map;
  return !!m && m.fog.length === fogCount;
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
  // 等在途事件链落定再删目录：否则 fire-and-forget 处理器写回会重建已删目录（/tmp 复活竞态）
  await opening.waitForSettled();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const id of createdProjectIds.splice(0)) {
    await projectService.update(id, { status: PROJECT_STATUS.PENDING }).catch(() => {});
    await projectService.delete(id).catch(() => { /* 忽略 */ });
  }
});

describe('MapOpening（#112 开图机制；#471 台账化）', () => {
  it('plan done + FOG → map 台账初始化（destination+fog，wuId=null），不再建 decision 单', async () => {
    const project = await createProject();
    const wu = await createPlanChainWu(project, 'DESTINATION: 把 X 做起来\nFOG: 存储选型？\nFOG: 部署形态？');

    await emitDone(wu);
    const ok = await waitFor(() => mapReady(project.id, 2));
    expect(ok).toBe(true);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.destination).toBe('把 X 做起来');
    expect(map.decisions).toEqual([]);
    expect(map.fog.map(f => f.question)).toEqual(['存储选型？', '部署形态？']);
    expect(map.fog.every(f => f.status === 'open')).toBe(true);
    // #471：不再逐条建 decision 单，fog[].wuId 恒 null（裁决在 plan 会话内进行）
    expect(map.fog.every(f => f.wuId === null)).toBe(true);
    expect((await decisionWus()).length).toBe(0);

    // 幂等哨兵落档
    expect(metaOf((await wuService.getById(wu.id))!.metadata).mapOpenedAt).toBeTruthy();
  });

  it('存量 analysis 单 done + FOG → 同样只落台账不建 decision 单（旧派生退役）', async () => {
    const project = await createProject();
    const wu = await createPlanChainWu(project, 'FOG: 存储选型？', 'analysis');

    await emitDone(wu);
    const ok = await waitFor(() => mapReady(project.id, 1));
    expect(ok).toBe(true);

    expect((await decisionWus()).length).toBe(0);
    expect((await projectService.get(project.id))!.map!.fog[0].wuId).toBeNull();
  });

  it('幂等：同一 plan WU 重复 done 事件不重复初始化 map', async () => {
    const project = await createProject();
    const wu = await createPlanChainWu(project, 'FOG: 存储选型？\nFOG: 部署形态？');

    await emitDone(wu);
    await waitFor(() => mapReady(project.id, 2));
    const mapBefore = (await projectService.get(project.id))!.map!;

    await emitDone(wu);
    await new Promise(r => setTimeout(r, 150));

    expect((await decisionWus()).length).toBe(0);
    expect((await projectService.get(project.id))!.map!.fog).toEqual(mapBefore.fog);
  });

  it('DESTINATION 缺省 → destination 回退项目 title；兼容中文冒号', async () => {
    const project = await createProject();
    const wu = await createPlanChainWu(project, 'FOG：存储选型？');

    await emitDone(wu);
    const ok = await waitFor(() => mapReady(project.id, 1));
    expect(ok).toBe(true);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.destination).toBe(project.title);
    expect(map.fog[0].question).toBe('存储选型？');
  });

  it('#401：中文别名「目标：/待决：」与英文 DESTINATION:/FOG: 同效', async () => {
    const project = await createProject();
    const wu = await createPlanChainWu(project, '目标：把 X 做起来\n待决：存储选型？\n待决：部署形态？');

    await emitDone(wu);
    const ok = await waitFor(() => mapReady(project.id, 2));
    expect(ok).toBe(true);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.destination).toBe('把 X 做起来');
    expect(map.fog.map(f => f.question)).toEqual(['存储选型？', '部署形态？']);
  });

  it('无待决问题清单（无 FOG 行）：不炸、不初始化、不落哨兵', async () => {
    const project = await createProject();
    const wu = await createPlanChainWu(project, '结论没问题，可以开工');

    await emitDone(wu);
    await new Promise(r => setTimeout(r, 150));

    expect((await projectService.get(project.id))!.map).toBeFalsy();
    expect((await decisionWus()).length).toBe(0);
    expect(metaOf((await wuService.getById(wu.id))!.metadata).mapOpenedAt).toBeUndefined();
  });

  it('无待决问题清单首开不动；后续人工确认补填 FOG 清单仍可开图', async () => {
    const project = await createProject();
    const wu = await createPlanChainWu(project); // 无 summary

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

    const ok = await waitFor(() => mapReady(project.id, 1));
    expect(ok).toBe(true);
  });

  it('已有 map 的 PMO：不重建', async () => {
    const project = await createProject();
    await projectService.update(project.id, {
      map: {
        destination: '老目的地',
        decisions: [],
        fog: [{ id: 'fog-old', question: '老问题', wuId: null, status: 'open' }],
      },
    });
    const wu = await createPlanChainWu(project, 'FOG: 新问题？');

    await emitDone(wu);
    await new Promise(r => setTimeout(r, 150));

    const map = (await projectService.get(project.id))!.map!;
    expect(map.destination).toBe('老目的地');
    expect(map.fog.length).toBe(1);
    expect(map.fog[0].id).toBe('fog-old');
    expect((await decisionWus()).length).toBe(0);
  });

  it('非 PMO（缺 pmoId）/ 非 analysis·plan 类型 / 非 done 状态：忽略', async () => {
    const project = await createProject();
    const noPmo = await wuService.create({
      type: 'plan',
      scope: '无 PMO 规划',
      channelId: 'ch-test',
      status: 'in_review',
      metadata: { attestations: l3('FOG: 存储选型？') },
    });
    await emitDone(noPmo);

    const wu = await createPlanChainWu(project, 'FOG: 存储选型？');
    eventBus.publish('workunit.status_changed', { workunit: { ...wu, status: 'in_review' } });
    eventBus.publish('workunit.status_changed', { workunit: { ...wu, type: 'task', status: 'done' } });
    await new Promise(r => setTimeout(r, 150));

    expect((await projectService.get(project.id))!.map).toBeFalsy();
    expect((await decisionWus()).length).toBe(0);
  });
});
