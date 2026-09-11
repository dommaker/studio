/**
 * #410 PMO progress-rollup：per-project 聚合 memo + 去抖合并测试
 *
 * 锁定票体 AC：
 * - 稳态 memo 命中路径零存储读（不再调 reqService.list() / getIndex()；仅冷启动/回源例外）
 * - 同一项目事件突发合并为一次归约回写（N 个连续事件 → 1 次项目写）
 * - memo 增量更新正确性（归约结果只由事件负载喂出的 memo 驱动）
 * - 项目新增 WU 感知 = created 事件记账（created 只记账不触发归约，与现状一致）
 * - 哨兵漂移兜底：派生哨兵（analysisTasksSpawnedAt）落档不发事件，memo 滞后判「未落定」时
 *   回源复核一次，按新鲜存储翻转（语义 = 现状永远读新鲜存储）
 *
 * 探测手法：spy RequirementService.prototype.list / FileStore.prototype.getIndex 计存储读；
 * 事件用 eventBus.publish 合成（绕开 wuService 自身的存储读，spy 计数全部可归因到 rollup）。
 * 项目经 projectService 写入（落 #219 setup 钉的隔离根 projects/，非真实 ~/.studio；
 * progress-rollup.test.ts 同款约定），afterEach 统一清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eventBus, FileStore } from '@dommaker/studio-shared';
import { initPmoProgressRollup, waitForPmoProgressRollupSettled, rollupTiming } from '../progress-rollup.js';
import { projectService, PROJECT_STATUS, type ProjectData } from '../project.service.js';
import { RequirementService } from '../../requirements/requirement.service.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

const att = (kind: string) => ({ verdict: 'approved', by: 'x', at: '2026-07-29T00:30:00Z', kind });
const fullEvidence = { attestations: { l1: att('verify'), l2: att('agent-review'), l3: att('human-confirm') } };
const evidenceMeta = JSON.stringify(fullEvidence);

let tmpDir: string;
let fileStore: FileStore;
let reqService: RequirementService;
let wuService: WorkUnitService;
const createdProjectIds: string[] = [];
const offs: Array<() => void> = [];

async function createRealProject(): Promise<ProjectData> {
  const project = await projectService.create({
    title: `410-rollup-memo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  createdProjectIds.push(project.id);
  return project;
}

/** 合成 status_changed（负载口径 = snapshotToData 全量数据；这里只给 rollup 消费的最小字段集） */
function pubStatus(wu: { id: string; status: string; type: string; reqId?: string | null; metadata?: string | null }): void {
  eventBus.publish('workunit.status_changed', { workunit: wu });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-rollup-memo-test-'));
  fileStore = new FileStore(tmpDir);
  reqService = new RequirementService(fileStore);
  wuService = new WorkUnitService(fileStore);
});

afterEach(async () => {
  vi.restoreAllMocks();
  rollupTiming.debounceMs = 50; // 复位去抖窗口（生产默认值）
  for (const off of offs.splice(0)) off();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const id of createdProjectIds.splice(0)) {
    await projectService.update(id, { status: PROJECT_STATUS.PENDING }).catch(() => {});
    await projectService.delete(id).catch(() => { /* 忽略 */ });
  }
});

describe('#410 memo 存储读收口', () => {
  it('冷启动回源一次后转纯增量：稳态 memo 命中零 list/getIndex，归约结果由负载驱动', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    const w1 = await wuService.create({ scope: 'w1', type: 'task', status: 'unassigned', reqId: req.id, metadata: fullEvidence });
    const w2 = await wuService.create({ scope: 'w2', type: 'task', status: 'unassigned', reqId: req.id, metadata: fullEvidence });

    const listSpy = vi.spyOn(RequirementService.prototype, 'list');
    const indexSpy = vi.spyOn(FileStore.prototype, 'getIndex');
    offs.push(initPmoProgressRollup(fileStore));

    // 首个事件：冷启动回源恰好一次（list + getIndex 各 1）
    pubStatus({ id: w1.id, status: 'active', type: 'task', reqId: req.id, metadata: evidenceMeta });
    await waitForPmoProgressRollupSettled();
    expect(listSpy.mock.calls.length).toBe(1);
    expect(indexSpy.mock.calls.length).toBe(1);

    // 稳态：连续事件全部走 memo 增量，零存储读；归约结果（含 completed 翻转）纯由负载驱动
    listSpy.mockClear();
    indexSpy.mockClear();
    pubStatus({ id: w1.id, status: 'done', type: 'task', reqId: req.id, metadata: evidenceMeta });
    pubStatus({ id: w2.id, status: 'active', type: 'task', reqId: req.id, metadata: evidenceMeta });
    pubStatus({ id: w2.id, status: 'done', type: 'task', reqId: req.id, metadata: evidenceMeta });
    await waitForPmoProgressRollupSettled();

    expect(listSpy.mock.calls.length).toBe(0);
    expect(indexSpy.mock.calls.length).toBe(0);
    const after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED);
    expect(after!.progress).toBe(100);
  });

  it('同一项目事件突发合并为一次归约回写（连续状态迁移 → 1 次项目写）', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    const w1 = await wuService.create({ scope: 'w1', type: 'task', status: 'done', reqId: req.id, metadata: fullEvidence });
    const w2 = await wuService.create({ scope: 'w2', type: 'task', status: 'unassigned', reqId: req.id, metadata: fullEvidence });

    // 窗口盖住整串真实迁移 IO，保证合并；未合并时现状为 2 次写
    // （w2 active 时 progress=50 一次 update + w2 done 时 completed 翻转一次 updateStatus）
    rollupTiming.debounceMs = 300;
    offs.push(initPmoProgressRollup(fileStore));
    const updateSpy = vi.spyOn(projectService, 'update');
    const statusSpy = vi.spyOn(projectService, 'updateStatus');

    await wuService.transitionStatus(w2.id, 'active');
    await wuService.transitionStatus(w2.id, 'in_review');
    await wuService.transitionStatus(w2.id, 'done');
    await waitForPmoProgressRollupSettled();

    // updateStatus 内部委派 update（写 status 字段）——逻辑写次数 = 直写 progress 的 update（不带 status 字段）+ updateStatus
    const directProgressWrites = updateSpy.mock.calls.filter(
      c => !('status' in (c[1] as Record<string, unknown>)),
    );
    expect(directProgressWrites.length + statusSpy.mock.calls.length).toBe(1);
    expect(statusSpy).toHaveBeenCalledWith(project.id, PROJECT_STATUS.COMPLETED, true);
    const after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED);
    expect(after!.progress).toBe(100);
    void w1;
  });

  it('created 事件感知项目新增 WU（created 直落 active 无 status_changed）：只记账不触发，归约零存储读计入', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    const w0 = await wuService.create({ scope: 'w0', type: 'task', status: 'unassigned', reqId: req.id, metadata: fullEvidence });

    offs.push(initPmoProgressRollup(fileStore));
    // 预热：冷启动回源后 memo 转暖（w0 active，progress 0）
    pubStatus({ id: w0.id, status: 'active', type: 'task', reqId: req.id, metadata: evidenceMeta });
    await waitForPmoProgressRollupSettled();
    expect((await projectService.get(project.id))!.progress).toBe(0);

    // created 直落 active（无 status_changed）：created 事件只记账不触发归约
    const w1 = await wuService.create({ scope: 'w1', type: 'task', status: 'active', reqId: req.id, metadata: fullEvidence });
    await waitForPmoProgressRollupSettled();
    expect((await projectService.get(project.id))!.progress).toBe(0);

    // 下一个 status_changed：memo 已含 w1 → total=2、finished=1 → progress=50，零存储读。
    // （created 未记账则 total=1 → progress=100 并误翻 in_review）
    const listSpy = vi.spyOn(RequirementService.prototype, 'list');
    const indexSpy = vi.spyOn(FileStore.prototype, 'getIndex');
    pubStatus({ id: w0.id, status: 'done', type: 'task', reqId: req.id, metadata: evidenceMeta });
    await waitForPmoProgressRollupSettled();

    expect(listSpy.mock.calls.length).toBe(0);
    expect(indexSpy.mock.calls.length).toBe(0);
    const after = await projectService.get(project.id);
    expect(after!.progress).toBe(50);
    expect(after!.status).toBe(PROJECT_STATUS.PENDING);
    void w1;
  });

  it('哨兵漂移兜底：memo 滞后判「派生未落定」→ 回源复核一次，按新鲜存储翻转 completed', async () => {
    const project = await createRealProject();
    const req = await reqService.create({ title: '需求', projectId: project.id });
    // 已完结 analysis 缺 analysisTasksSpawnedAt（接力未处理）→ 假相全完结
    const w1 = await wuService.create({
      scope: 'a1', type: 'analysis', status: 'done', reqId: req.id,
      metadata: { attestations: { l3: att('human-confirm') } },
    });
    const w2 = await wuService.create({ scope: 'w2', type: 'task', status: 'done', reqId: req.id, metadata: fullEvidence });

    offs.push(initPmoProgressRollup(fileStore));
    pubStatus({ id: w2.id, status: 'done', type: 'task', reqId: req.id, metadata: evidenceMeta });
    await waitForPmoProgressRollupSettled();

    // 派生未落定：不翻 completed，progress 照写（#115 语义不变）
    let after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.PENDING);
    expect(after!.progress).toBe(100);

    // 哨兵经 update 落档（不发事件），memo 中 w1 仍滞后为「未落定」
    await wuService.update(w1.id, {
      metadata: { attestations: { l3: att('human-confirm') }, analysisTasksSpawnedAt: '2026-08-31T00:00:00Z' },
    });

    // 兄弟事件再触发：memo 判未落定 → 回源复核一次 → 按新鲜存储翻 completed
    const listSpy = vi.spyOn(RequirementService.prototype, 'list');
    pubStatus({ id: w2.id, status: 'done', type: 'task', reqId: req.id, metadata: evidenceMeta });
    await waitForPmoProgressRollupSettled();

    expect(listSpy.mock.calls.length).toBe(1); // 恰好复核一次（非每事件全量）
    after = await projectService.get(project.id);
    expect(after!.status).toBe(PROJECT_STATUS.COMPLETED);
    expect(after!.progress).toBe(100);
  });
});
