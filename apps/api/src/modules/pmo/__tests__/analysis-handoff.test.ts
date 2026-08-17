/**
 * AnalysisHandoff 单测（PMO 分析接力：分析结论 → 拆任务 → 派工）
 *
 * 覆盖：
 *  - analysis → in_review：频道发人工确认提示（不派自动评审）
 *  - analysis → done（人工确认）：按 metadata.analysisTasks 建未指派 task 子 WU
 *    （parentId/频道/pmo 元数据继承），频道发任务清单
 *  - 幂等：analysisTasksSpawnedAt 哨兵，重复 done 事件不重复派生
 *  - 无 TASK 拆分行：不派生，频道提示可手动转任务
 *  - 非 analysis 类型 / 其他状态：忽略
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service.js';
import { AnalysisHandoff } from '../analysis-handoff.js';

// #186（#167 决议 2）：无频道确认提示改投 Web「需要处理」收件箱 —— 告警出口 mock
const mockDispatch = vi.fn();
vi.mock('../../agents/monitor/monitor-alerts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agents/monitor/monitor-alerts.js')>();
  return { ...actual, dispatchMonitorAlerts: (...args: unknown[]) => mockDispatch(...args) };
});

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let handoff: AnalysisHandoff;

function metaOf(raw: string | null): WorkUnitMetadata {
  return raw ? JSON.parse(raw) as WorkUnitMetadata : {};
}

async function channelMessages() {
  return fileStore.queryMessages('ch-test', {});
}

async function createAnalysisWu(metadata: WorkUnitMetadata): Promise<WorkUnitData> {
  return wuService.create({
    type: 'analysis',
    scope: '分析需求 PMO-1: 测试需求',
    channelId: 'ch-test',
    status: 'active',
    metadata,
  });
}

/** 轮询等待异步事件处理落定（同 decision-resolution/progress-rollup 等姊妹测试；
 *  固定 sleep 在 forks 并行负载下不可靠——handler 是 6 步串行文件 I/O，实测超 50ms） */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

/** 手工发 status_changed（快照状态与 payload 一致） */
function emitStatus(wu: WorkUnitData, status: string) {
  eventBus.publish('workunit.status_changed', { workunit: { ...wu, status } });
}

beforeEach(async () => {
  mockDispatch.mockClear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-handoff-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  eventBus.unsubscribeAll?.('workunit.status_changed');
  handoff = new AnalysisHandoff(fileStore, wuService);
  handoff.subscribeToEvents();

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

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AnalysisHandoff（PMO 分析接力）', () => {
  it('analysis → in_review：频道发人工确认提示（含派工预告）', async () => {
    const wu = await createAnalysisWu({ analysisTasks: ['任务一', '任务二'] });
    emitStatus(wu, 'in_review');

    const ok = await waitFor(async () => (await channelMessages()).length === 1);
    expect(ok).toBe(true);
    const msgs = await channelMessages();
    expect(msgs[0].workUnitId).toBe(wu.id);
    expect(msgs[0].content).toContain('人工');
    expect(msgs[0].content).toContain('自动派工');
  });

  it('analysis → done：按 analysisTasks 建未指派 task 子 WU + 频道清单', async () => {
    const wu = await createAnalysisWu({
      analysisTasks: ['实现登录接口', '补登录单测'],
      pmoId: 'proj-1',
      pmoNumber: 'PMO-1',
    });
    emitStatus(wu, 'done');

    const ok = await waitFor(async () =>
      (await fileStore.getIndex()).filter(s => s.parentId === wu.id).length === 2);
    expect(ok).toBe(true);
    const snapshots = await fileStore.getIndex();
    const children = snapshots.filter(s => s.parentId === wu.id);
    expect(children.length).toBe(2);
    expect(children.every(c => c.type === 'task')).toBe(true);
    expect(children.every(c => c.status === 'unassigned')).toBe(true);
    expect(children.every(c => c.channelId === 'ch-test')).toBe(true);
    const scopes = children.map(c => c.scope).sort();
    expect(scopes).toEqual(['实现登录接口', '补登录单测'].sort());
    // PMO 溯源元数据继承
    expect(metaOf(children[0].metadata).pmoNumber).toBe('PMO-1');
    expect(metaOf(children[0].metadata).creationMode).toBe('analysis-breakdown');

    // 幂等哨兵落档
    const after = await wuService.getById(wu.id);
    expect(metaOf(after!.metadata).analysisTasksSpawnedAt).toBeTruthy();

    const msgOk = await waitFor(async () =>
      (await channelMessages()).some(m => m.content.includes('拆分 2 个任务')));
    expect(msgOk).toBe(true);
  });

  it('幂等：重复 done 事件不重复派生', async () => {
    const wu = await createAnalysisWu({ analysisTasks: ['任务一'] });
    emitStatus(wu, 'done');
    const ok = await waitFor(async () =>
      (await fileStore.getIndex()).filter(s => s.parentId === wu.id).length === 1);
    expect(ok).toBe(true);

    emitStatus(wu, 'done');
    // 负向断言（不重复派生）无轮询条件，给二次事件一个处理窗口（同姊妹测试先例）
    await new Promise(r => setTimeout(r, 150));

    const snapshots = await fileStore.getIndex();
    expect(snapshots.filter(s => s.parentId === wu.id).length).toBe(1);
  });

  it('B3a 归属链继承：analysis 的 workspaceRoot 传给 task 子 WU（无则不 inherited）', async () => {
    const wu = await createAnalysisWu({
      analysisTasks: ['任务一'],
      workspaceRoot: '/root/projects/demo',
    });
    emitStatus(wu, 'done');

    const ok = await waitFor(async () =>
      (await fileStore.getIndex()).filter(s => s.parentId === wu.id).length === 1);
    expect(ok).toBe(true);
    const snapshots = await fileStore.getIndex();
    const children = snapshots.filter(s => s.parentId === wu.id);
    expect(children.length).toBe(1);
    expect(metaOf(children[0].metadata).workspaceRoot).toBe('/root/projects/demo');

    // 无 workspaceRoot 的 analysis：子 WU 不带该字段（不编造）
    const wu2 = await createAnalysisWu({ analysisTasks: ['任务二'] });
    emitStatus(wu2, 'done');
    const ok2 = await waitFor(async () =>
      (await fileStore.getIndex()).filter(s => s.parentId === wu2.id).length === 1);
    expect(ok2).toBe(true);
    const children2 = (await fileStore.getIndex()).filter(s => s.parentId === wu2.id);
    expect(children2.length).toBe(1);
    expect(metaOf(children2[0].metadata).workspaceRoot).toBeUndefined();
  });

  it('#177：analysis 确认时指定默认执行角色 → 全部派生 task 子 WU 带 assigneeId（未指定 = 涌现，不带）', async () => {
    const wu = await createAnalysisWu({
      analysisTasks: ['实现登录接口', '补登录单测'],
      defaultTaskAssigneeId: 'profile-7',
    });
    emitStatus(wu, 'done');

    const ok = await waitFor(async () =>
      (await fileStore.getIndex()).filter(s => s.parentId === wu.id).length === 2);
    expect(ok).toBe(true);
    const children = (await fileStore.getIndex()).filter(s => s.parentId === wu.id);
    expect(children.every(c => c.assigneeId === 'profile-7')).toBe(true);

    // 未指定：子 WU 不带 assigneeId（回池涌现）
    const wu2 = await createAnalysisWu({ analysisTasks: ['另一个任务'] });
    emitStatus(wu2, 'done');
    const ok2 = await waitFor(async () =>
      (await fileStore.getIndex()).filter(s => s.parentId === wu2.id).length === 1);
    expect(ok2).toBe(true);
    const children2 = (await fileStore.getIndex()).filter(s => s.parentId === wu2.id);
    expect(children2[0].assigneeId).toBeFalsy();
  });

  it('无 TASK 拆分行：不派生，频道提示可手动转任务', async () => {
    const wu = await createAnalysisWu({});
    emitStatus(wu, 'done');

    const msgOk = await waitFor(async () =>
      (await channelMessages()).some(m => m.content.includes('未输出 TASK')));
    expect(msgOk).toBe(true);
    const snapshots = await fileStore.getIndex();
    expect(snapshots.filter(s => s.parentId === wu.id).length).toBe(0);
  });

  it('非 analysis 类型 / 其他状态：忽略', async () => {
    const task = await wuService.create({ type: 'task', scope: '普通任务', channelId: 'ch-test', status: 'active' });
    emitStatus(task, 'in_review');
    emitStatus(task, 'done');
    // 负向断言（忽略）无轮询条件，给一个处理窗口
    await new Promise(r => setTimeout(r, 150));

    const msgs = await channelMessages();
    expect(msgs.length).toBe(0);
  });
});

// #186（#167 决议，2026-08-16）：trigger 巡检单免确认直转 done / 带 TASK 走闸 + 提示投 Web 收件箱
describe('#186 trigger 巡检单收口（#167 决议 1/2）', () => {
  /** 建无频道 analysis WU（trigger 巡检单形态），并真实迁移到 in_review（persistSnapshot 自发事件） */
  async function createTriggerWuInReview(metadata: WorkUnitMetadata): Promise<WorkUnitData> {
    const wu = await wuService.create({
      type: 'analysis',
      scope: '定时巡检：知识库质量',
      channelId: null,
      status: 'active',
      metadata,
    });
    await wuService.transitionStatus(wu.id, 'in_review');
    return wu;
  }

  async function freshStatus(id: string): Promise<string | undefined> {
    return (await fileStore.getIndex()).find(s => s.id === id)?.status;
  }

  it('决议 1：trigger + 无频道 + 无 TASK → 免确认直转 done（不过人闸、不留痕收件箱）', async () => {
    const wu = await createTriggerWuInReview({
      triggerId: 'knowledge-quality',
      triggerSource: 'trigger-registry',
      triggeredAt: new Date().toISOString(),
    });

    // 留痕写入在 reviewPassed 置 done 之后，waitFor 需连带等留痕落定，避免全量并行负载下的断言竞态
    const ok = await waitFor(async () => {
      const after = await wuService.getById(wu.id);
      return (await freshStatus(wu.id)) === 'done'
        && metaOf(after?.metadata ?? null).autoConfirmedBy === 'trigger-inspection-no-gate';
    });
    expect(ok).toBe(true);
    // 留痕：自动确认标记落档
    const after = await wuService.getById(wu.id);
    expect(metaOf(after!.metadata).autoConfirmedBy).toBe('trigger-inspection-no-gate');
    expect(metaOf(after!.metadata).autoConfirmedAt).toBeTruthy();
    // 不投收件箱、不派生子 WU
    expect(mockDispatch).not.toHaveBeenCalled();
    expect((await fileStore.getIndex()).filter(s => s.parentId === wu.id).length).toBe(0);
  });

  it('决议 1 边界：analysisTasks 为空数组/空白行 = 无 TASK → 同样直转 done', async () => {
    const wu = await createTriggerWuInReview({
      triggerId: 'session-knowledge-extraction',
      triggerSource: 'trigger-registry',
      analysisTasks: ['', '   '],
    });

    const ok = await waitFor(async () => (await freshStatus(wu.id)) === 'done');
    expect(ok).toBe(true);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('决议 2：trigger + 无频道 + 带 TASK → 保留人闸（停 in_review），提示投 Web 收件箱', async () => {
    const wu = await createTriggerWuInReview({
      triggerId: 'knowledge-quality',
      triggerSource: 'trigger-registry',
      analysisTasks: ['修复失效知识条目'],
    });

    const ok = await waitFor(() => Promise.resolve(mockDispatch.mock.calls.length === 1));
    expect(ok).toBe(true);
    const alerts = mockDispatch.mock.calls[0][0] as Array<{ source: string; level: string; message: string; relatedTaskIds?: string[] }>;
    expect(alerts[0].source).toBe('analysis_confirm');
    expect(alerts[0].level).toBe('warning');
    expect(alerts[0].relatedTaskIds).toContain(wu.id);
    expect(alerts[0].message).toContain('通过');
    // 人闸保留：不自动 done、不派生
    await new Promise(r => setTimeout(r, 150));
    expect(await freshStatus(wu.id)).toBe('in_review');
    expect((await fileStore.getIndex()).filter(s => s.parentId === wu.id).length).toBe(0);
  });

  it('决议 2 边界：非 trigger 的无频道 analysis → 不直转，提示同样投收件箱（修 channelId=null 吞提示）', async () => {
    const wu = await wuService.create({
      type: 'analysis',
      scope: '手动创建的无频道分析',
      channelId: null,
      status: 'active',
      metadata: {},
    });
    await wuService.transitionStatus(wu.id, 'in_review');

    const ok = await waitFor(() => Promise.resolve(mockDispatch.mock.calls.length === 1));
    expect(ok).toBe(true);
    expect(await freshStatus(wu.id)).toBe('in_review');
  });

  it('频道发起的 analysis（有 channelId）维持确认闸不变：频道提示、不直转、不投收件箱', async () => {
    const wu = await createAnalysisWu({
      triggerId: 'knowledge-quality', // 即便带 trigger 溯源，有频道即走频道闸
      triggerSource: 'trigger-registry',
      analysisTasks: ['任务一'],
    });
    emitStatus(wu, 'in_review');

    const ok = await waitFor(async () => (await channelMessages()).length === 1);
    expect(ok).toBe(true);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(await freshStatus(wu.id)).not.toBe('done');
  });
});
