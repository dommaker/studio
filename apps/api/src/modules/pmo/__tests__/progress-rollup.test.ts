/**
 * B3a 工程归属链（决策 D2）— PMO 项目进度回写测试
 *
 * 覆盖：
 * - WU 状态变化（事件）→ 按项目下全部 Requirement 关联 WU 的完结比例重算 progress
 * - 全部完结 → status 置 completed（completedAt/progress=100）
 * - Requirement 无 projectId / 项目已 completed / 无关联 WU → 不动作
 * - 订阅解绑（off）后不再回写
 *
 * 约定：PMO 项目写真实 ~/.studio/projects（workspace-binding.test.ts 同款约定），
 * afterEach 统一删除（completed 项目先复位状态再删）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eventBus, FileStore } from '@dommaker/studio-shared';
import { initPmoProgressRollup, syncProjectProgress, syncProjectProgressByReqId } from '../progress-rollup.js';
import { projectService, PROJECT_STATUS, type ProjectData } from '../project.service.js';
import { RequirementService } from '../../requirements/requirement.service.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
let reqService: RequirementService;
let wuService: WorkUnitService;
const createdProjectIds: string[] = [];

/** 轮询直至条件满足（事件订阅是 fire-and-forget，需要给异步回写留时间窗） */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

async function createRealProject(): Promise<ProjectData> {
  const project = await projectService.create({
    title: `b3a-rollup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  createdProjectIds.push(project.id);
  return project;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-rollup-test-'));
  fileStore = new FileStore(tmpDir);
  reqService = new RequirementService(fileStore);
  wuService = new WorkUnitService(fileStore);
});

afterEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const id of createdProjectIds.splice(0)) {
    // delete 仅允许 pending/cancelled —— 先复位再删
    await projectService.update(id, { status: PROJECT_STATUS.PENDING }).catch(() => {});
    await projectService.delete(id).catch(() => { /* 忽略 */ });
  }
});

describe('syncProjectProgress（B3a 进度回写）', () => {
  it('部分完结 → progress 按比例更新，status 不变', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id });
    await wuService.create({ scope: 'w2', type: 'task', status: 'active', reqId: req.id });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.progress).toBe(50);
    expect(after!.status).toBe(PROJECT_STATUS.PENDING);
  });

  it('全部完结 → status=completed + progress=100 + completedAt', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id });
    await wuService.create({ scope: 'w2', type: 'task', status: 'closed', reqId: req.id });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED);
    expect(after!.progress).toBe(100);
    expect(after!.completedAt).toBeTruthy();
  });

  it('只统计该项目下的 WU（其他需求的 WU 不影响）', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    const otherReq = await reqService.create({ title: '无关需求' });
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id });
    await wuService.create({ scope: 'w2', type: 'task', status: 'active', reqId: otherReq.id });
    await wuService.create({ scope: 'w3', type: 'task', status: 'active' }); // 无 reqId

    await syncProjectProgress(project.id, fileStore);

    expect((await projectService.get(project.id))!.progress).toBe(100);
    expect((await projectService.get(project.id))!.status).toBe(PROJECT_STATUS.COMPLETED);
  });

  it('多个 Requirement 挂同一项目 → 合并统计', async () => {
    const project = await createRealProject();
    const r1 = await reqService.create({ title: '需求一', projectId: project.id });
    const r2 = await reqService.create({ title: '需求二', projectId: project.id });
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: r1.id });
    await wuService.create({ scope: 'w2', type: 'task', status: 'active', reqId: r2.id });
    await wuService.create({ scope: 'w3', type: 'task', status: 'active', reqId: r2.id });

    await syncProjectProgress(project.id, fileStore);

    expect((await projectService.get(project.id))!.progress).toBe(33);
  });

  it('项目已 completed → 不再回写', async () => {
    const project = await createRealProject();
    await projectService.update(project.id, { status: PROJECT_STATUS.ACTIVE });
    await projectService.updateStatus(project.id, PROJECT_STATUS.IN_REVIEW);
    await projectService.updateStatus(project.id, PROJECT_STATUS.COMPLETED);
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'w1', type: 'task', status: 'active', reqId: req.id });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED);
    expect(after!.progress).toBe(100); // 未被重算为 0
  });

  it('无关联 WU → 不动作（progress 保持原值）', async () => {
    const project = await createRealProject();
    await reqService.create({ title: '需求', projectId: project.id });

    await syncProjectProgress(project.id, fileStore);

    expect((await projectService.get(project.id))!.progress).toBe(0);
  });

  it('项目不存在 → 不抛错', async () => {
    await expect(syncProjectProgress('proj-no-such', fileStore)).resolves.toBeUndefined();
  });
});

describe('syncProjectProgressByReqId', () => {
  it('Requirement 无 projectId → 不动作', async () => {
    const req = await reqService.create({ title: '无归属需求' });
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id });

    await expect(syncProjectProgressByReqId(req.id, fileStore)).resolves.toBeUndefined();
  });

  it('REQ 不存在 → 不抛错', async () => {
    await expect(syncProjectProgressByReqId('REQ-9999', fileStore)).resolves.toBeUndefined();
  });
});

describe('initPmoProgressRollup（事件接线）', () => {
  it('workunit.status_changed → 回写关联项目进度；off 后不再回写', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    const wu = await wuService.create({ scope: 'w1', type: 'task', status: 'unassigned', reqId: req.id });
    const off = initPmoProgressRollup(fileStore);
    try {
      // unassigned → active → in_review → done，每次状态变化都触发回写
      await wuService.transitionStatus(wu.id, 'active');
      await wuService.transitionStatus(wu.id, 'in_review');
      await wuService.transitionStatus(wu.id, 'done');

      const synced = await waitFor(async () => (await projectService.get(project.id))!.status === PROJECT_STATUS.COMPLETED);
      expect(synced).toBe(true);
      expect((await projectService.get(project.id))!.progress).toBe(100);
    } finally {
      off();
    }
  });

  it('无 reqId 的事件忽略；off 后事件不再消费', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id });
    const off = initPmoProgressRollup(fileStore);
    off();

    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-x', reqId: req.id } });
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-y', reqId: null } });
    await new Promise(r => setTimeout(r, 100));

    expect((await projectService.get(project.id))!.progress).toBe(0);
  });
});
