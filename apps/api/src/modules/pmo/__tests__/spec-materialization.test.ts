/**
 * SpecMaterialization 单测（#115 T9：交稿物化订阅器，#106 验收标准 4）
 *
 * 覆盖（验收标准 4 + 边界）：
 *  - parseSpecTasks：TASK 行逐段解析（AC 多段 / BLOCKEDBY 逗号 / LEG / 中文冒号）；
 *    非 TASK 行忽略；上限截断
 *  - spec 单 reviewPassed（done）→ 批量建未指派 task 单，metadata 带
 *    pmoId/ac/blockedBy/腿归属（LEG 命中 → workspaceRoot），父链 parentId 溯源
 *  - 幂等：specTasksSpawnedAt 哨兵，重复 done 事件不重复建单
 *  - 边界：无 TASK 行不建不落哨兵；LEG 未命中 → 不落 workspaceRoot 仍建单；
 *    非 spec 类型 / 非 done 状态忽略
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
import { SpecMaterialization, parseSpecTasks, SPEC_TASKS_MAX } from '../spec-materialization.js';

const REPO_A = '/tmp/spec-mat-repo-a';
const REPO_B = '/tmp/spec-mat-repo-b';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let materialization: SpecMaterialization;
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

async function createProject(gitRepos?: string[]): Promise<ProjectData> {
  const project = await projectService.create({
    title: `t9-spec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...(gitRepos ? { gitRepos } : {}),
  });
  createdProjectIds.push(project.id);
  return (await projectService.get(project.id))!;
}

async function createSpecWu(project: ProjectData, summary?: string): Promise<WorkUnitData> {
  return wuService.create({
    type: 'spec',
    scope: `成文 ${project.pmoNumber}`,
    status: 'in_review',
    channelId: 'chan-test',
    metadata: {
      pmoId: project.id,
      pmoNumber: project.pmoNumber,
      ...(summary !== undefined
        ? {
          attestations: {
            l3: {
              verdict: 'approved',
              by: 'tester',
              at: '2026-08-11T00:00:00Z',
              kind: 'human-confirm',
              summary,
            },
          },
        }
        : {}),
    },
  });
}

async function emitDone(wu: WorkUnitData) {
  eventBus.publish('workunit.status_changed', { workunit: { ...wu, status: 'done' } });
}

async function taskWus(): Promise<Array<{ id: string; status: string; parentId: string | null; metadata: string | null }>> {
  return (await fileStore.getIndex()).filter(s => s.type === 'task');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-materialization-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  eventBus.unsubscribeAll?.('workunit.status_changed');
  materialization = new SpecMaterialization(fileStore, wuService);
  materialization.subscribeToEvents();
});

afterEach(async () => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const id of createdProjectIds.splice(0)) {
    await projectService.update(id, { status: PROJECT_STATUS.PENDING }).catch(() => {});
    await projectService.delete(id).catch(() => { /* 忽略 */ });
  }
});

describe('parseSpecTasks（物化清单解析）', () => {
  it('TASK 行逐段解析：标题 + AC 多段 + BLOCKEDBY 逗号 + LEG', () => {
    const tasks = parseSpecTasks([
      '确认结论如上。',
      'TASK: 实现存储层 | AC: 单测全绿 | AC: 覆盖合并冲突路径 | BLOCKEDBY: wu-1, wu-2 | LEG: /repo/a',
      'TASK：迁移配置 ｜ 不是约定分隔符（全角竖线不拆段）',
      'TASK:   ',
      'FOG: 与物化无关的行',
    ].join('\n'));
    expect(tasks.length).toBe(2);
    expect(tasks[0]).toEqual({
      title: '实现存储层',
      ac: ['单测全绿', '覆盖合并冲突路径'],
      blockedBy: ['wu-1', 'wu-2'],
      leg: '/repo/a',
    });
    // 全角竖线不分段（契约只认 ASCII |），整段即标题
    expect(tasks[1]!.title).toContain('迁移配置');
    expect(tasks[1]!.ac).toEqual([]);
    expect(tasks[1]!.blockedBy).toEqual([]);
    expect(tasks[1]!.leg).toBeUndefined();
  });

  it('BLOCKEDBY 兼容中文逗号；未知段忽略', () => {
    const tasks = parseSpecTasks('TASK: 甲 | BLOCKEDBY: wu-1，wu-2 | NOTE: 备注不解析');
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.blockedBy).toEqual(['wu-1', 'wu-2']);
  });

  it(`清单上限 ${SPEC_TASKS_MAX} 条`, () => {
    const summary = Array.from({ length: SPEC_TASKS_MAX + 5 }, (_, i) => `TASK: 任务${i + 1}`).join('\n');
    expect(parseSpecTasks(summary).length).toBe(SPEC_TASKS_MAX);
  });
});

describe('SpecMaterialization（#115 交稿物化）', () => {
  it('spec 通过 → 批量建未指派 task 单（ac/blockedBy/腿归属/parentId/pmoId 齐全）', async () => {
    const project = await createProject([REPO_A, REPO_B]);
    const wu = await createSpecWu(project, [
      '成文确认，物化如下：',
      `TASK: 存储层实现 | AC: 单测全绿 | BLOCKEDBY: wu-dep-1 | LEG: ${REPO_A}`,
      `TASK: 配置层实现 | AC: 兼容旧配置 | LEG: ${REPO_B}`,
    ].join('\n'));

    await emitDone(wu);
    const ok = await waitFor(async () => (await taskWus()).length === 2);
    expect(ok).toBe(true);

    const tasks = await taskWus();
    const metas = tasks.map(t => metaOf(t.metadata));
    for (const t of tasks) {
      expect(t.status).toBe('unassigned');
      expect(t.parentId).toBe(wu.id);
    }
    const first = metas.find(m => m.workspaceRoot === REPO_A)!;
    expect(first.creationMode).toBe('spec-materialization');
    expect(first.pmoId).toBe(project.id);
    expect(first.pmoNumber).toBe(project.pmoNumber);
    expect(first.ac).toEqual(['单测全绿']);
    expect(first.blockedBy).toEqual(['wu-dep-1']);
    const second = metas.find(m => m.workspaceRoot === REPO_B)!;
    expect(second.ac).toEqual(['兼容旧配置']);
    expect(second.blockedBy).toBeUndefined();

    // 幂等哨兵落档
    const fresh = await wuService.getById(wu.id);
    expect(metaOf(fresh!.metadata).specTasksSpawnedAt).toBeTruthy();
  });

  it('幂等：重复 done 事件不重复建单', async () => {
    const project = await createProject([REPO_A, REPO_B]);
    const wu = await createSpecWu(project, 'TASK: 存储层实现 | LEG: ' + REPO_A);

    await emitDone(wu);
    await waitFor(async () => (await taskWus()).length === 1);
    await emitDone(wu);
    await new Promise(r => setTimeout(r, 100));

    expect((await taskWus()).length).toBe(1);
  });

  it('无 TASK 行：不建单但恒落哨兵（rollup 派生未落定判定的输入）', async () => {
    const project = await createProject([REPO_A, REPO_B]);
    const wu = await createSpecWu(project, '本次成文只记录决策，无拆分。');

    await emitDone(wu);
    const ok = await waitFor(async () =>
      Boolean(metaOf((await wuService.getById(wu.id))!.metadata).specTasksSpawnedAt));
    expect(ok).toBe(true);
    expect((await taskWus()).length).toBe(0);
  });

  it('LEG 未命中项目交付腿：仍建单但不落 workspaceRoot（公共 WU）', async () => {
    const project = await createProject([REPO_A, REPO_B]);
    const wu = await createSpecWu(project, 'TASK: 跨腿公共活 | LEG: /repo/不存在');

    await emitDone(wu);
    const ok = await waitFor(async () => (await taskWus()).length === 1);
    expect(ok).toBe(true);
    expect(metaOf((await taskWus())[0]!.metadata).workspaceRoot).toBeUndefined();
  });

  it('单腿项目（无 deliveries 显式多腿）：LEG 命中合成单腿 gitRepo 也落 workspaceRoot', async () => {
    const project = await createProject(); // 无 gitRepo → 合成腿 gitRepo=null
    await projectService.update(project.id, { gitRepo: REPO_A });
    const wu = await createSpecWu(project, 'TASK: 单腿任务 | LEG: ' + REPO_A);

    await emitDone(wu);
    const ok = await waitFor(async () => (await taskWus()).length === 1);
    expect(ok).toBe(true);
    expect(metaOf((await taskWus())[0]!.metadata).workspaceRoot).toBe(REPO_A);
  });

  it('非 spec 类型 / 非 done 状态：忽略', async () => {
    const project = await createProject([REPO_A, REPO_B]);
    const wu = await createSpecWu(project, 'TASK: 不该建');

    eventBus.publish('workunit.status_changed', { workunit: { ...wu, status: 'in_review' } });
    eventBus.publish('workunit.status_changed', { workunit: { ...wu, type: 'decision', status: 'done' } });
    await new Promise(r => setTimeout(r, 150));

    expect((await taskWus()).length).toBe(0);
  });
});
