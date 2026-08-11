/**
 * B3a 工程归属链（决策 D2）— PMO 项目进度回写测试
 *
 * 覆盖：
 * - WU 状态变化（事件）→ 按项目下全部 Requirement 关联 WU 的完结比例重算 progress
 * - 全部完结 → 证据感知翻转：证据齐 → completed（completedAt/progress=100）；
 *   证据缺口 → active/pending 置 in_review（等证据验收），已 in_review 不动
 * - Requirement 无 projectId / 项目已 completed（不回退）/ 无关联 WU → 不动作
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
import { initPmoProgressRollup, syncProjectProgress, syncProjectProgressByReqId, parseWuMetaPmoId } from '../progress-rollup.js';
import { projectService, PROJECT_STATUS, type ProjectData } from '../project.service.js';
import { RequirementService } from '../../requirements/requirement.service.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

/** 三层证据齐全的 metadata（l1 自动验证 / l2 agent 评审 / l3 人工确认） */
const att = (kind: string) => ({ verdict: 'approved', by: 'x', at: '2026-07-29T00:30:00Z', kind });
const fullEvidence = { attestations: { l1: att('verify'), l2: att('agent-review'), l3: att('human-confirm') } };

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

  it('全部完结且证据齐 → status=completed + progress=100 + completedAt', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id, metadata: fullEvidence });
    await wuService.create({ scope: 'w2', type: 'task', status: 'closed', reqId: req.id, metadata: fullEvidence });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED);
    expect(after!.progress).toBe(100);
    expect(after!.completedAt).toBeTruthy();
  });

  it('全部完结但缺 L3 人工确认 → 置 in_review（不冒充 completed）', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({
      scope: 'w1', type: 'task', status: 'done', reqId: req.id,
      metadata: { attestations: { l1: att('verify'), l2: att('agent-review') } },
    });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.IN_REVIEW);
    expect(after!.progress).toBe(100);
    expect(after!.completedAt).toBeFalsy();
  });

  it('active 项目全部完结但证据缺口 → 同样置 in_review', async () => {
    const project = await createRealProject();
    await projectService.update(project.id, { status: PROJECT_STATUS.ACTIVE });
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id }); // 无证据

    await syncProjectProgress(project.id, fileStore);

    expect((await projectService.get(project.id))!.status).toBe(PROJECT_STATUS.IN_REVIEW);
  });

  it('已 in_review 且证据仍缺 → 不动；证据补齐后重算 → 翻 completed（读取纠偏路径）', async () => {
    const project = await createRealProject();
    await projectService.update(project.id, { status: PROJECT_STATUS.ACTIVE });
    await projectService.updateStatus(project.id, PROJECT_STATUS.IN_REVIEW);
    const req = await reqService.create({ title: '需求', projectId: project.id });
    const wu = await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id }); // 无证据

    await syncProjectProgress(project.id, fileStore);
    expect((await projectService.get(project.id))!.status).toBe(PROJECT_STATUS.IN_REVIEW);

    // 幂等补写证据（不产生状态事件），读取时重算纠偏
    await wuService.update(wu.id, { metadata: fullEvidence });
    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED);
    expect(after!.progress).toBe(100);
  });

  it('只统计该项目下的 WU（其他需求的 WU 不影响）', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    const otherReq = await reqService.create({ title: '无关需求' });
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id, metadata: fullEvidence });
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

  it('已 completed 项目即使证据有缺口也不回退（不翻回 in_review）', async () => {
    const project = await createRealProject();
    await projectService.update(project.id, { status: PROJECT_STATUS.ACTIVE });
    await projectService.updateStatus(project.id, PROJECT_STATUS.IN_REVIEW);
    await projectService.updateStatus(project.id, PROJECT_STATUS.COMPLETED);
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id }); // 无证据

    await syncProjectProgress(project.id, fileStore);

    expect((await projectService.get(project.id))!.status).toBe(PROJECT_STATUS.COMPLETED);
  });

  it('无关联 WU → 不动作（progress 保持原值）', async () => {
    const project = await createRealProject();
    await reqService.create({ title: '需求', projectId: project.id });

    await syncProjectProgress(project.id, fileStore);

    expect((await projectService.get(project.id))!.progress).toBe(0);
  });

  it('analysis 派生链：无 Requirement，按 metadata.pmoId 回退统计（他项目 WU 不计入）', async () => {
    const project = await createRealProject();
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', metadata: { pmoId: project.id } });
    await wuService.create({ scope: 'w2', type: 'task', status: 'active', metadata: { pmoId: project.id } });
    await wuService.create({ scope: 'w3', type: 'task', status: 'done', metadata: { pmoId: 'proj-other' } });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.progress).toBe(50);
    expect(after!.status).toBe(PROJECT_STATUS.PENDING);
  });

  it('analysis 派生链全部完结且证据齐 → completed + progress=100（口径同主路径）', async () => {
    const project = await createRealProject();
    await wuService.create({ scope: 'w1', type: 'task', status: 'done', metadata: { pmoId: project.id, ...fullEvidence } });
    await wuService.create({ scope: 'w2', type: 'task', status: 'closed', metadata: { pmoId: project.id, ...fullEvidence } });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED);
    expect(after!.progress).toBe(100);
    expect(after!.completedAt).toBeTruthy();
  });

  it('项目不存在 → 不抛错', async () => {
    await expect(syncProjectProgress('proj-no-such', fileStore)).resolves.toBeUndefined();
  });
});

describe('#115 派生链未落定不翻 completed（derivationPending）', () => {
  it('已完结 analysis 缺 analysisTasksSpawnedAt（接力未处理）→ 不翻 completed，progress 照写', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({
      scope: 'a1', type: 'analysis', status: 'done', reqId: req.id,
      metadata: { attestations: { l3: att('human-confirm') } }, // analysis 证据已齐（l2 豁免）
    });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.PENDING); // 假相全完结被拦
    expect(after!.progress).toBe(100);
  });

  it('analysis 哨兵已落（接力已处理）→ 正常翻 completed', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({
      scope: 'a1', type: 'analysis', status: 'done', reqId: req.id,
      metadata: { analysisTasksSpawnedAt: '2026-08-11T00:00:00Z', attestations: { l3: att('human-confirm') } },
    });

    await syncProjectProgress(project.id, fileStore);

    expect((await projectService.get(project.id))!.status).toBe(PROJECT_STATUS.COMPLETED);
  });

  it('探路型：map 存在但 specSpawnedAt 未落 → 不翻 completed', async () => {
    const project = await createRealProject();
    await projectService.update(project.id, {
      map: {
        destination: 'd',
        decisions: [],
        fog: [{ id: 'fog-1', question: 'q', wuId: 'wu-x', status: 'open' }],
      },
    });
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({
      scope: 'd1', type: 'decision', status: 'done', reqId: req.id,
      metadata: { attestations: { l3: att('human-confirm') } },
    });

    await syncProjectProgress(project.id, fileStore);

    expect((await projectService.get(project.id))!.status).toBe(PROJECT_STATUS.PENDING);
  });

  it('已完结 spec 缺 specTasksSpawnedAt（物化未处理）→ 不翻 completed', async () => {
    const project = await createRealProject();
    await projectService.update(project.id, {
      map: {
        destination: 'd',
        decisions: [],
        fog: [{ id: 'fog-1', question: 'q', wuId: 'wu-x', status: 'resolved' }],
        specSpawnedAt: '2026-08-11T00:00:00Z',
      },
    });
    const req = await reqService.create({ title: '需求', projectId: project.id });
    await wuService.create({
      scope: 's1', type: 'spec', status: 'done', reqId: req.id,
      metadata: { attestations: { l3: att('human-confirm') } },
    });

    await syncProjectProgress(project.id, fileStore);

    expect((await projectService.get(project.id))!.status).toBe(PROJECT_STATUS.PENDING);
  });

  it('多腿：派生未落定窗口腿状态也不翻（腿 completed 同样是假相）', async () => {
    const project = await projectService.create({
      title: `t9-rollup-multileg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      gitRepos: ['/repo/a', '/repo/b'],
    });
    createdProjectIds.push(project.id);
    const req = await reqService.create({ title: '需求', projectId: project.id });
    // 腿 a 命中（workspaceRoot），已完结但缺接力哨兵 → 派生未落定
    await wuService.create({
      scope: 'a1', type: 'analysis', status: 'done', reqId: req.id,
      metadata: { workspaceRoot: '/repo/a', attestations: { l3: att('human-confirm') } },
    });

    await syncProjectProgress(project.id, fileStore);

    const after = await projectService.get(project.id);
    expect(after!.status).not.toBe(PROJECT_STATUS.COMPLETED);
    expect(after!.deliveries!.map(l => l.status)).toEqual(['pending', 'pending']); // 腿不翻
    expect(after!.progress).toBe(100);
  });
});

describe('parseWuMetaPmoId', () => {
  it('解析 metadata.pmoId；坏 JSON / 非字符串 / 空值容错为 null', () => {
    expect(parseWuMetaPmoId(JSON.stringify({ pmoId: 'proj-1' }))).toBe('proj-1');
    expect(parseWuMetaPmoId('{broken')).toBeNull();
    expect(parseWuMetaPmoId(JSON.stringify({ pmoId: 42 }))).toBeNull();
    expect(parseWuMetaPmoId(JSON.stringify({}))).toBeNull();
    expect(parseWuMetaPmoId(null)).toBeNull();
    expect(parseWuMetaPmoId(undefined)).toBeNull();
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
    const wu = await wuService.create({ scope: 'w1', type: 'task', status: 'unassigned', reqId: req.id, metadata: fullEvidence });
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

  it('无 reqId 但 metadata.pmoId 存在 → 回退按 pmoId 回写进度', async () => {
    const project = await createRealProject();
    const wu = await wuService.create({ scope: 'w1', type: 'task', status: 'unassigned', metadata: { pmoId: project.id, ...fullEvidence } });
    const off = initPmoProgressRollup(fileStore);
    try {
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
