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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service.js';
import { AnalysisHandoff } from '../analysis-handoff.js';

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

/** 手工发 status_changed（快照状态与 payload 一致） */
async function emitStatus(wu: WorkUnitData, status: string) {
  eventBus.publish('workunit.status_changed', { workunit: { ...wu, status } });
  await new Promise(r => setTimeout(r, 50));
}

beforeEach(async () => {
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
    await emitStatus(wu, 'in_review');

    const msgs = await channelMessages();
    expect(msgs.length).toBe(1);
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
    await emitStatus(wu, 'done');

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

    const msgs = await channelMessages();
    expect(msgs.some(m => m.content.includes('拆分 2 个任务'))).toBe(true);
  });

  it('幂等：重复 done 事件不重复派生', async () => {
    const wu = await createAnalysisWu({ analysisTasks: ['任务一'] });
    await emitStatus(wu, 'done');
    await emitStatus(wu, 'done');

    const snapshots = await fileStore.getIndex();
    expect(snapshots.filter(s => s.parentId === wu.id).length).toBe(1);
  });

  it('B3a 归属链继承：analysis 的 workspaceRoot 传给 task 子 WU（无则不 inherited）', async () => {
    const wu = await createAnalysisWu({
      analysisTasks: ['任务一'],
      workspaceRoot: '/root/projects/demo',
    });
    await emitStatus(wu, 'done');

    const snapshots = await fileStore.getIndex();
    const children = snapshots.filter(s => s.parentId === wu.id);
    expect(children.length).toBe(1);
    expect(metaOf(children[0].metadata).workspaceRoot).toBe('/root/projects/demo');

    // 无 workspaceRoot 的 analysis：子 WU 不带该字段（不编造）
    const wu2 = await createAnalysisWu({ analysisTasks: ['任务二'] });
    await emitStatus(wu2, 'done');
    const children2 = (await fileStore.getIndex()).filter(s => s.parentId === wu2.id);
    expect(children2.length).toBe(1);
    expect(metaOf(children2[0].metadata).workspaceRoot).toBeUndefined();
  });

  it('无 TASK 拆分行：不派生，频道提示可手动转任务', async () => {
    const wu = await createAnalysisWu({});
    await emitStatus(wu, 'done');

    const snapshots = await fileStore.getIndex();
    expect(snapshots.filter(s => s.parentId === wu.id).length).toBe(0);
    const msgs = await channelMessages();
    expect(msgs.some(m => m.content.includes('未输出 TASK'))).toBe(true);
  });

  it('非 analysis 类型 / 其他状态：忽略', async () => {
    const task = await wuService.create({ type: 'task', scope: '普通任务', channelId: 'ch-test', status: 'active' });
    await emitStatus(task, 'in_review');
    await emitStatus(task, 'done');

    const msgs = await channelMessages();
    expect(msgs.length).toBe(0);
  });
});
