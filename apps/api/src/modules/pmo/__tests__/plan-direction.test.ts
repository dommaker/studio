/**
 * PlanDirection 单测（#567：方向锁定——plan 裁决轮前置的一次性方向人闸）
 *
 * 覆盖（方案 docs/plans/2026-09-plan-direction-picker.md P2 + AC4）：
 *  - 选定方向落账：map.decisions[] 追加「方向：<name>——<summary>（人锁定）」结论
 *    （map 未建则就地初始化），方向抉择点命中 fog 条目 → 置 resolved（缺失不补建）
 *  - 复活同会话：composeDirectionReply 文本经 resumeWaitingWorkUnit 注入 pendingReplies
 *    → active（sessionId 不动），waitingReason/planDirections 清除，频道里程碑留痕
 *  - 幂等：同 wuId 同结论不双写 decisions[]
 *  - 无 pmoId：只复活不写台账；非 blocked / 无 planDirections → 拒绝
 *  - 载荷校验：choice 必填非空 / 必须在候选 name 集合内 / note 可选 → PlanDirectionError
 *
 * 约定同 plan-ruling.test.ts：PMO 项目经 projectService 写入（落隔离根 projects/），
 * afterEach 统一删除。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service.js';
import { projectService, PROJECT_STATUS, type ProjectData, type PmoMap } from '../project.service.js';
import { applyPlanDirection, validateDirectionPick, PlanDirectionError } from '../plan-direction.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
const createdProjectIds: string[] = [];

function metaOf(raw: string | null): WorkUnitMetadata {
  return raw ? JSON.parse(raw) as WorkUnitMetadata : {};
}

async function createProject(): Promise<ProjectData> {
  const project = await projectService.create({
    title: `direction-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  createdProjectIds.push(project.id);
  return (await projectService.get(project.id))!;
}

const DIRECTIONS = {
  question: '自研还是引入依赖？',
  options: [
    { name: '自研', summary: '自研调度内核', tradeoffs: '可控但慢', impact: '触及 scheduler 模块', recommended: true },
    { name: '引入依赖', summary: '引入 bullmq', tradeoffs: '快但多一个依赖', impact: '触及 api 与 daemon', recommended: false },
  ],
};

async function createDirectionWu(project?: ProjectData): Promise<WorkUnitData> {
  return wuService.create({
    type: 'plan',
    scope: '规划需求 PMO-1: 测试',
    channelId: 'ch-test',
    status: 'blocked',
    assigneeId: 'instance-1',
    metadata: {
      ...(project ? { pmoId: project.id } : {}),
      waitingForInput: true,
      waitingQuestion: '方向锁定——请选定本票方向',
      waitingReason: 'plan-direction',
      planDirections: DIRECTIONS,
      sessionId: 'sess-1',
    },
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-direction-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  await fileStore.createChannel({
    id: 'ch-test', name: '#test', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  });
});

afterEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const id of createdProjectIds.splice(0)) {
    await projectService.update(id, { status: PROJECT_STATUS.PENDING }).catch(() => {});
    await projectService.delete(id).catch(() => { /* 忽略 */ });
  }
});

describe('#567 applyPlanDirection：方向选定落账 + 同会话复活', () => {
  it('选定方向：map 就地初始化 + decisions 落「方向：…（人锁定）」结论，fog 命中置 resolved', async () => {
    const project = await createProject();
    await projectService.update(project.id, {
      map: {
        destination: project.title,
        decisions: [],
        fog: [{ id: 'fog-1', question: '自研还是引入依赖？', wuId: null, status: 'open' }],
      } satisfies PmoMap,
    });
    const wu = await createDirectionWu(project);

    const updated = await applyPlanDirection(wu.id, { choice: '自研', note: '要可控' }, fileStore);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.decisions).toHaveLength(1);
    expect(map.decisions[0].summary).toBe('方向：自研——自研调度内核（人锁定）');
    expect(map.decisions[0].wuId).toBe(wu.id);
    expect(map.decisions[0].resolvedAt).toBeTruthy();
    expect(map.fog.find(f => f.id === 'fog-1')!.status).toBe('resolved');

    // 复活：active + 选定方向注入 pendingReplies + 挂起/方向标记清除 + 会话不动
    expect(updated.status).toBe('active');
    const meta = metaOf(updated.metadata);
    expect(meta.waitingForInput).toBeFalsy();
    expect(meta.waitingReason).toBeUndefined();
    expect(meta.planDirections).toBeUndefined();
    expect(meta.sessionId).toBe('sess-1');
    const replies = meta.pendingReplies ?? [];
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('方向锁定结果');
    expect(replies[0]).toContain('自研');
    expect(replies[0]).toContain('是 agent 推荐方向');
    expect(replies[0]).toContain('要可控');

    // 频道里程碑留痕（Web 按钮动作双出声）
    const messages = await fileStore.queryMessages('ch-test', { workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('方向锁定') && m.content.includes('自研'))).toBe(true);
  });

  it('方向抉择点不在 fog：不补建 fog 条目，只落 decisions', async () => {
    const project = await createProject();
    const wu = await createDirectionWu(project);

    await applyPlanDirection(wu.id, { choice: '引入依赖' }, fileStore);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.destination).toBe(project.title); // 就地初始化回退项目标题
    expect(map.fog).toHaveLength(0); // 方向题不一定来自 fog——缺失不补建
    expect(map.decisions).toHaveLength(1);
    expect(map.decisions[0].summary).toBe('方向：引入依赖——引入 bullmq（人锁定）');

    const meta = metaOf((await wuService.getById(wu.id))!.metadata);
    expect(meta.pendingReplies![0]).toContain('引入依赖');
    expect(meta.pendingReplies![0]).toContain('不是 agent 推荐方向'); // 非推荐方向如实标注
  });

  it('幂等：同 wuId 同结论不双写 decisions[]', async () => {
    const project = await createProject();
    const wu = await createDirectionWu(project);
    await projectService.update(project.id, {
      map: {
        destination: project.title,
        decisions: [{ wuId: wu.id, summary: '方向：自研——自研调度内核（人锁定）', resolvedAt: '2026-09-16T00:00:00Z' }],
        fog: [],
      } satisfies PmoMap,
    });

    await applyPlanDirection(wu.id, { choice: '自研' }, fileStore);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.decisions).toHaveLength(1); // 不双写
  });

  it('无 pmoId：只复活同会话，不写台账不炸', async () => {
    const wu = await createDirectionWu();

    const updated = await applyPlanDirection(wu.id, { choice: '自研' }, fileStore);

    expect(updated.status).toBe('active');
    const meta = metaOf(updated.metadata);
    expect(meta.pendingReplies![0]).toContain('自研');
    expect(meta.planDirections).toBeUndefined();
  });

  it('拒绝：非 blocked / 无待选 planDirections', async () => {
    const project = await createProject();
    const active = await wuService.create({
      type: 'plan', scope: 'x', channelId: 'ch-test', status: 'active',
      metadata: { pmoId: project.id, planDirections: DIRECTIONS },
    });
    await expect(applyPlanDirection(active.id, { choice: '自研' }, fileStore)).rejects.toThrow(/blocked/);

    const noDirections = await wuService.create({
      type: 'plan', scope: 'y', channelId: 'ch-test', status: 'blocked',
      metadata: { pmoId: project.id, waitingForInput: true },
    });
    await expect(applyPlanDirection(noDirections.id, { choice: '自研' }, fileStore)).rejects.toThrow(/direction/i);
  });
});

describe('#567 validateDirectionPick：载荷校验', () => {
  it('合法载荷原样通过（note 可省）', () => {
    expect(validateDirectionPick({ choice: '自研', note: '要可控' }, DIRECTIONS))
      .toEqual({ choice: '自研', note: '要可控' });
    expect(validateDirectionPick({ choice: '引入依赖' }, DIRECTIONS))
      .toEqual({ choice: '引入依赖' });
  });

  it('非法载荷抛 PlanDirectionError（400 类别）', () => {
    expect(() => validateDirectionPick(undefined, DIRECTIONS)).toThrow(PlanDirectionError);
    expect(() => validateDirectionPick(null, DIRECTIONS)).toThrow(PlanDirectionError);
    expect(() => validateDirectionPick('自研', DIRECTIONS)).toThrow(PlanDirectionError);
    expect(() => validateDirectionPick({}, DIRECTIONS)).toThrow(PlanDirectionError);
    expect(() => validateDirectionPick({ choice: '' }, DIRECTIONS)).toThrow(PlanDirectionError);
    expect(() => validateDirectionPick({ choice: '  ' }, DIRECTIONS)).toThrow(PlanDirectionError);
    expect(() => validateDirectionPick({ choice: 42 }, DIRECTIONS)).toThrow(PlanDirectionError);
    expect(() => validateDirectionPick({ note: 'x' }, DIRECTIONS)).toThrow(PlanDirectionError);
  });

  it('choice 必须在候选 name 集合内', () => {
    expect(() => validateDirectionPick({ choice: '第三条路' }, DIRECTIONS)).toThrow(PlanDirectionError);
    expect(() => validateDirectionPick({ choice: '第三条路' }, DIRECTIONS)).toThrow(/不在候选方向内/);
  });

  it('字段截 500 字符（choice/note）', () => {
    const long = 'x'.repeat(600);
    const pick = validateDirectionPick({ choice: '自研', note: long }, DIRECTIONS);
    expect(pick.note).toHaveLength(500);
  });
});
