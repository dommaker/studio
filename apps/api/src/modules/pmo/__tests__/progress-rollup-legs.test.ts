/**
 * #113 T7（#106 子票）：多腿项目进度回写——腿状态独立演进 + 全腿完结才翻整体
 *
 * 覆盖：
 * - 逐腿状态：腿内 WU 全完结且证据齐 → 腿 completed；证据缺口 → 腿 in_review；
 *   有在途 → pending 腿转 active；他腿在途不阻断本腿翻 completed
 * - 整体翻转条件 = 全部腿 completed/delivered（零 WU 腿不阻断）；有腿缺证据 → 项目 in_review
 * - progress 仍按项目全部 WU 完结比例（语义不变）
 *
 * 单腿回归由 progress-rollup.test.ts 兜底（不改断言全绿）。
 * 约定同 progress-rollup.test.ts：项目写真实 ~/.studio/projects，afterEach 复位删除。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { syncProjectProgress } from '../progress-rollup.js';
import { projectService, PROJECT_STATUS, type ProjectData } from '../project.service.js';
import { RequirementService } from '../../requirements/requirement.service.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

const att = (kind: string) => ({ verdict: 'approved', by: 'x', at: '2026-07-29T00:30:00Z', kind });
const fullEvidence = { attestations: { l1: att('verify'), l2: att('agent-review'), l3: att('human-confirm') } };

const TWO_LEGS = [
  { gitRepo: '/repo/a', branch: 'PMO-a', status: 'pending' },
  { gitRepo: '/repo/b', branch: 'PMO-b', status: 'pending' },
];

let tmpDir: string;
let fileStore: FileStore;
let reqService: RequirementService;
let wuService: WorkUnitService;
const createdProjectIds: string[] = [];

async function createMultiLegProject(): Promise<ProjectData> {
  const project = await projectService.create({
    title: `t7-rollup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  createdProjectIds.push(project.id);
  // create 不落 deliveries（#114 创建表单负责）；测试经 update 落显式多腿
  return projectService.update(project.id, { deliveries: TWO_LEGS });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-rollup-legs-test-'));
  fileStore = new FileStore(tmpDir);
  reqService = new RequirementService(fileStore);
  wuService = new WorkUnitService(fileStore);
});

afterEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const id of createdProjectIds.splice(0)) {
    await projectService.update(id, { status: PROJECT_STATUS.PENDING }).catch(() => {});
    await projectService.delete(id).catch(() => { /* 忽略 */ });
  }
});

describe('syncProjectProgress 多腿（#113 T7）', () => {
  it('腿 A 全完结证据齐 → 腿 A completed；腿 B 在途 → 腿 B active，项目整体不翻', async () => {
    const project = await createMultiLegProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'a1', type: 'task', status: 'done', reqId: req.id, metadata: { workspaceRoot: '/repo/a', ...fullEvidence } });
    await wuService.create({ scope: 'b1', type: 'task', status: 'active', reqId: req.id, metadata: { workspaceRoot: '/repo/b' } });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.deliveries).toEqual([
      expect.objectContaining({ branch: 'PMO-a', status: 'completed' }),
      expect.objectContaining({ branch: 'PMO-b', status: 'active' }),
    ]);
    expect(after!.status).toBe(PROJECT_STATUS.PENDING); // 全腿完结才翻整体
    expect(after!.progress).toBe(50);
  });

  it('全腿完结且证据齐 → 全腿 completed + 项目 completed + progress=100', async () => {
    const project = await createMultiLegProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'a1', type: 'task', status: 'done', reqId: req.id, metadata: { workspaceRoot: '/repo/a', ...fullEvidence } });
    await wuService.create({ scope: 'b1', type: 'task', status: 'closed', reqId: req.id, metadata: { workspaceRoot: '/repo/b', ...fullEvidence } });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.deliveries).toEqual([
      expect.objectContaining({ branch: 'PMO-a', status: 'completed' }),
      expect.objectContaining({ branch: 'PMO-b', status: 'completed' }),
    ]);
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED);
    expect(after!.progress).toBe(100);
    expect(after!.completedAt).toBeTruthy();
  });

  it('一腿证据缺口 → 该腿 in_review，项目置 in_review（不冒充 completed）', async () => {
    const project = await createMultiLegProject();
    await projectService.update(project.id, { status: PROJECT_STATUS.ACTIVE });
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'a1', type: 'task', status: 'done', reqId: req.id, metadata: { workspaceRoot: '/repo/a', ...fullEvidence } });
    await wuService.create({
      scope: 'b1', type: 'task', status: 'done', reqId: req.id,
      metadata: { workspaceRoot: '/repo/b', attestations: { l1: att('verify'), l2: att('agent-review') } }, // 缺 l3
    });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.deliveries).toEqual([
      expect.objectContaining({ branch: 'PMO-a', status: 'completed' }),
      expect.objectContaining({ branch: 'PMO-b', status: 'in_review' }),
    ]);
    expect(after!.status).toBe(PROJECT_STATUS.IN_REVIEW);
    expect(after!.completedAt).toBeFalsy();
  });

  it('未分腿公共 WU 计入每条腿：公共 WU 缺证据 → 两腿均 in_review', async () => {
    const project = await createMultiLegProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'a1', type: 'task', status: 'done', reqId: req.id, metadata: { workspaceRoot: '/repo/a', ...fullEvidence } });
    await wuService.create({ scope: 'shared', type: 'task', status: 'done', reqId: req.id, metadata: {} }); // 无腿戳 + 无证据

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.deliveries).toEqual([
      expect.objectContaining({ branch: 'PMO-a', status: 'in_review' }),
      expect.objectContaining({ branch: 'PMO-b', status: 'in_review' }),
    ]);
    expect(after!.status).toBe(PROJECT_STATUS.IN_REVIEW);
  });

  it('零 WU 腿不阻断整体翻转（无活可交的腿视为满足）', async () => {
    const project = await createMultiLegProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'a1', type: 'task', status: 'done', reqId: req.id, metadata: { workspaceRoot: '/repo/a', ...fullEvidence } });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.deliveries![0]).toEqual(expect.objectContaining({ branch: 'PMO-a', status: 'completed' }));
    expect(after!.deliveries![1].status).toBe('pending'); // 零 WU 腿状态不动
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED);
  });

  it('已 delivered 腿不被回写（终态）', async () => {
    const project = await createMultiLegProject();
    await projectService.update(project.id, {
      deliveries: [
        { gitRepo: '/repo/a', branch: 'PMO-a', status: 'delivered', deliverCommit: 'aaaa' },
        { gitRepo: '/repo/b', branch: 'PMO-b', status: 'pending' },
      ],
    });
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'a1', type: 'task', status: 'done', reqId: req.id, metadata: { workspaceRoot: '/repo/a', ...fullEvidence } });
    await wuService.create({ scope: 'b1', type: 'task', status: 'done', reqId: req.id, metadata: { workspaceRoot: '/repo/b', ...fullEvidence } });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.deliveries![0]).toEqual(expect.objectContaining({ branch: 'PMO-a', status: 'delivered', deliverCommit: 'aaaa' }));
    expect(after!.deliveries![1]).toEqual(expect.objectContaining({ branch: 'PMO-b', status: 'completed' }));
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED); // delivered 腿视为完结
  });
});
