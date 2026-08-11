/**
 * DecisionResolution 单测（#110 T4：决策落地订阅器）
 *
 * 覆盖（issue 验收两条 + 边界）：
 *  - decision 单 reviewPassed（done）→ map.decisions[] 原样追加人工结论 + 对应 fog 置 resolved
 *  - 幂等：同一 decision WU 的重复 done 事件不双写 decisions[]
 *  - 所属 PMO fog[] 全 resolved → 自动建未指派 spec 单（scope 带 PMO 引用、metadata.pmoId 溯源，
 *    specSpawnedAt 哨兵防重、specWuId 回写）；非全清不建
 *  - 边界：无 map 的 PMO（非探路型）不受影响；metadata 缺 fogId 不炸；缺 summary 落空串
 *
 * 约定同 progress-rollup.test.ts：PMO 项目写真实 ~/.studio/projects，afterEach 统一删除。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service.js';
import { projectService, PROJECT_STATUS, type ProjectData, type PmoMap } from '../project.service.js';
import { DecisionResolution } from '../decision-resolution.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let resolution: DecisionResolution;
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

async function createProject(map?: PmoMap | null): Promise<ProjectData> {
  const project = await projectService.create({
    title: `t4-decision-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  createdProjectIds.push(project.id);
  if (map) await projectService.update(project.id, { map });
  return (await projectService.get(project.id))!;
}

function twoFogMap(): PmoMap {
  return {
    destination: '把 X 做起来',
    decisions: [],
    fog: [
      { id: 'fog-1', question: '存储选型？', wuId: null, status: 'in-discussion' },
      { id: 'fog-2', question: '部署形态？', wuId: null, status: 'open' },
    ],
  };
}

async function createDecisionWu(project: ProjectData, fogId: string, summary?: string): Promise<WorkUnitData> {
  return wuService.create({
    type: 'decision',
    scope: `决策: ${fogId}`,
    status: 'in_review',
    metadata: {
      pmoId: project.id,
      pmoNumber: project.pmoNumber,
      fogId,
      attestations: {
        l3: {
          verdict: 'approved',
          by: 'tester',
          at: '2026-08-11T00:00:00Z',
          kind: 'human-confirm',
          ...(summary !== undefined ? { summary } : {}),
        },
      },
    },
  });
}

async function emitDone(wu: WorkUnitData) {
  eventBus.publish('workunit.status_changed', { workunit: { ...wu, status: 'done' } });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-resolution-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  eventBus.unsubscribeAll?.('workunit.status_changed');
  resolution = new DecisionResolution(fileStore, wuService);
  resolution.subscribeToEvents();
});

afterEach(async () => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const id of createdProjectIds.splice(0)) {
    await projectService.update(id, { status: PROJECT_STATUS.PENDING }).catch(() => {});
    await projectService.delete(id).catch(() => { /* 忽略 */ });
  }
});

describe('DecisionResolution（#110 决策落地）', () => {
  it('decision 通过 → decisions[] 原样追加人工结论 + 对应 fog 置 resolved', async () => {
    const project = await createProject(twoFogMap());
    const wu = await createDecisionWu(project, 'fog-1', '存储用 PostgreSQL，理由略');

    await emitDone(wu);
    const ok = await waitFor(async () => (await projectService.get(project.id))!.map!.decisions.length === 1);
    expect(ok).toBe(true);

    const after = (await projectService.get(project.id))!.map!;
    expect(after.decisions.length).toBe(1);
    expect(after.decisions[0].wuId).toBe(wu.id);
    expect(after.decisions[0].summary).toBe('存储用 PostgreSQL，理由略');
    expect(after.decisions[0].resolvedAt).toBeTruthy();
    expect(after.fog.find(f => f.id === 'fog-1')!.status).toBe('resolved');
    expect(after.fog.find(f => f.id === 'fog-2')!.status).toBe('open');
  });

  it('幂等：同一 decision WU 重复 done 事件不双写 decisions[]', async () => {
    const project = await createProject(twoFogMap());
    const wu = await createDecisionWu(project, 'fog-1', '结论一');

    await emitDone(wu);
    await waitFor(async () => (await projectService.get(project.id))!.map!.decisions.length === 1);
    await emitDone(wu);
    await new Promise(r => setTimeout(r, 100));

    const after = (await projectService.get(project.id))!.map!;
    expect(after.decisions.length).toBe(1);
  });

  it('非全清不建 spec 单；最后一雾 resolved → 自动建未指派 spec 单（scope/metadata 带 PMO 引用）', async () => {
    const project = await createProject(twoFogMap());
    const wu1 = await createDecisionWu(project, 'fog-1', '存储用 PostgreSQL');

    await emitDone(wu1);
    await waitFor(async () => (await projectService.get(project.id))!.map!.decisions.length === 1);
    // 非全清：不建 spec 单
    expect((await fileStore.getIndex()).filter(s => s.type === 'spec').length).toBe(0);
    expect((await projectService.get(project.id))!.map!.specSpawnedAt).toBeUndefined();

    const wu2 = await createDecisionWu(project, 'fog-2', '先单机部署');
    await emitDone(wu2);
    const ok = await waitFor(async () => (await fileStore.getIndex()).some(s => s.type === 'spec'));
    expect(ok).toBe(true);

    const spec = (await fileStore.getIndex()).find(s => s.type === 'spec')!;
    expect(spec.status).toBe('unassigned');
    expect(spec.scope).toContain(project.pmoNumber);
    const specMeta = metaOf(spec.metadata);
    expect(specMeta.pmoId).toBe(project.id);
    expect(specMeta.pmoNumber).toBe(project.pmoNumber);

    // 哨兵 + 溯源回写
    const map = (await projectService.get(project.id))!.map!;
    expect(map.specSpawnedAt).toBeTruthy();
    expect(map.specWuId).toBe(spec.id);
    expect(map.fog.every(f => f.status === 'resolved')).toBe(true);
  });

  it('spec 单只建一次：重复投递最后一雾事件不重复建', async () => {
    const project = await createProject({
      destination: '把 X 做起来',
      decisions: [],
      fog: [{ id: 'fog-1', question: '存储选型？', wuId: null, status: 'open' }],
    });
    const wu = await createDecisionWu(project, 'fog-1', '结论');

    await emitDone(wu);
    await waitFor(async () => (await fileStore.getIndex()).some(s => s.type === 'spec'));
    await emitDone(wu);
    await new Promise(r => setTimeout(r, 100));

    expect((await fileStore.getIndex()).filter(s => s.type === 'spec').length).toBe(1);
  });

  it('边界：无 map 的 PMO（非探路型）不受影响', async () => {
    const project = await createProject(null);
    const wu = await createDecisionWu(project, 'fog-1', '结论');

    await emitDone(wu);
    await new Promise(r => setTimeout(r, 150));

    const after = await projectService.get(project.id);
    expect(after!.map).toBeFalsy();
    expect((await fileStore.getIndex()).filter(s => s.type === 'spec').length).toBe(0);
  });

  it('边界：metadata 缺 fogId 不炸、不写', async () => {
    const project = await createProject(twoFogMap());
    const wu = await wuService.create({
      type: 'decision',
      scope: '决策: 无 fogId',
      status: 'in_review',
      metadata: { pmoId: project.id, pmoNumber: project.pmoNumber },
    });

    await emitDone(wu);
    await new Promise(r => setTimeout(r, 150));

    const after = (await projectService.get(project.id))!.map!;
    expect(after.decisions.length).toBe(0);
    expect(after.fog.every(f => f.status !== 'resolved')).toBe(true);
  });

  it('边界：fogId 在 map.fog 中找不到 → 不写不炸', async () => {
    const project = await createProject(twoFogMap());
    const wu = await createDecisionWu(project, 'fog-不存在', '结论');

    await emitDone(wu);
    await new Promise(r => setTimeout(r, 150));

    expect((await projectService.get(project.id))!.map!.decisions.length).toBe(0);
  });

  it('边界：人工未填结论（无 l3 summary）→ decisions[] 落空串，不拒写', async () => {
    const project = await createProject(twoFogMap());
    const wu = await createDecisionWu(project, 'fog-1'); // 无 summary

    await emitDone(wu);
    const ok = await waitFor(async () => (await projectService.get(project.id))!.map!.decisions.length === 1);
    expect(ok).toBe(true);
    expect((await projectService.get(project.id))!.map!.decisions[0].summary).toBe('');
  });

  it('非 decision 类型 / 非 done 状态：忽略', async () => {
    const project = await createProject(twoFogMap());
    const wu = await createDecisionWu(project, 'fog-1', '结论');

    eventBus.publish('workunit.status_changed', { workunit: { ...wu, status: 'in_review' } });
    eventBus.publish('workunit.status_changed', { workunit: { ...wu, type: 'task', status: 'done' } });
    await new Promise(r => setTimeout(r, 150));

    expect((await projectService.get(project.id))!.map!.decisions.length).toBe(0);
  });
});
