/**
 * PlanRuling 单测（#467：裁决轮——plan 一脉会话内的一次性人闸）
 *
 * 覆盖（票体「形态更新 2026-09-09」验收 + 边界）：
 *  - 一次性裁决：采纳题批量落账（map 未建则就地初始化，decisions[] 追加 + fog 置 resolved），
 *    打回重议题保持 open（只重调该题）
 *  - 复活同会话：组合裁决结果文本经 resumeWaitingWorkUnit 注入 pendingReplies → active
 *    （sessionId 不动），waitingReason/planRulings 清除，频道里程碑留痕（Web 动作双出声）
 *  - 幂等：fog 已 resolved 且同结论不双写 decisions[]
 *  - 无 pmoId：只复活不写台账；非 blocked / 无待裁 rulings → 拒绝
 *  - 载荷校验：空清单 / 未知 action / 采纳缺结论 / 超 12 条 → PlanRulingError
 *
 * 约定同 map-opening.test.ts：PMO 项目写真实 ~/.studio/projects，afterEach 统一删除。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service.js';
import { projectService, PROJECT_STATUS, type ProjectData, type PmoMap } from '../project.service.js';
import { applyPlanRuling, validateRulingItems, PlanRulingError } from '../plan-ruling.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
const createdProjectIds: string[] = [];

function metaOf(raw: string | null): WorkUnitMetadata {
  return raw ? JSON.parse(raw) as WorkUnitMetadata : {};
}

async function createProject(): Promise<ProjectData> {
  const project = await projectService.create({
    title: `ruling-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  createdProjectIds.push(project.id);
  return (await projectService.get(project.id))!;
}

const RULINGS = [
  { question: '存储选型？', suggestion: 'SQLite', default: 'SQLite' },
  { question: '部署形态？', suggestion: '单机' },
];

async function createRulingWu(project?: ProjectData): Promise<WorkUnitData> {
  return wuService.create({
    type: 'plan',
    scope: '规划需求 PMO-1: 测试',
    channelId: 'ch-test',
    status: 'blocked',
    assigneeId: 'instance-1',
    metadata: {
      ...(project ? { pmoId: project.id } : {}),
      waitingForInput: true,
      waitingQuestion: '裁决轮——2 个待决问题请一次性裁决',
      waitingReason: 'plan-ruling',
      planRulings: RULINGS,
      sessionId: 'sess-1',
    },
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-ruling-'));
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

describe('#467 applyPlanRuling：一次性裁决落账 + 同会话复活', () => {
  it('全部采纳：map 就地初始化（destination 回退项目标题），fog 全 resolved + decisions 批量落账', async () => {
    const project = await createProject();
    const wu = await createRulingWu(project);

    const updated = await applyPlanRuling(wu.id, [
      { question: '存储选型？', action: 'accept', conclusion: 'SQLite' },
      { question: '部署形态？', action: 'accept', conclusion: '单机部署' },
    ], fileStore);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.destination).toBe(project.title);
    expect(map.fog).toHaveLength(2);
    expect(map.fog.every(f => f.status === 'resolved' && f.wuId === null)).toBe(true);
    expect(map.fog.map(f => f.question)).toEqual(['存储选型？', '部署形态？']);
    expect(map.decisions).toHaveLength(2);
    expect(map.decisions.map(d => d.summary)).toEqual(['SQLite', '单机部署']);
    expect(map.decisions.every(d => d.wuId === wu.id && d.resolvedAt)).toBe(true);

    // 复活：active + 裁决结果注入 pendingReplies + 挂起/裁决标记清除 + 会话不动
    expect(updated.status).toBe('active');
    const meta = metaOf(updated.metadata);
    expect(meta.waitingForInput).toBeFalsy();
    expect(meta.waitingReason).toBeUndefined();
    expect(meta.planRulings).toBeUndefined();
    expect(meta.sessionId).toBe('sess-1');
    const replies = meta.pendingReplies ?? [];
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('裁决轮结果');
    expect(replies[0]).toContain('采纳「存储选型？」：SQLite');
    expect(replies[0]).toContain('采纳「部署形态？」：单机部署');

    // 频道里程碑留痕（Web 按钮动作双出声）
    const messages = await fileStore.queryMessages('ch-test', { workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('裁决轮已确认') && m.content.includes('采纳 2'))).toBe(true);
  });

  it('单题修改 + 某题打回重议：已有 map 上采纳置 resolved（结论用人改后文本），打回题保持 open', async () => {
    const project = await createProject();
    const preset: PmoMap = {
      destination: project.title,
      decisions: [],
      fog: [
        { id: 'fog-1', question: '存储选型？', wuId: null, status: 'open' },
        { id: 'fog-2', question: '部署形态？', wuId: null, status: 'open' },
      ],
    };
    await projectService.update(project.id, { map: preset });
    const wu = await createRulingWu(project);

    await applyPlanRuling(wu.id, [
      { question: '存储选型？', action: 'accept', conclusion: '改判：用 Postgres' },
      { question: '部署形态？', action: 'reopen' },
    ], fileStore);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.fog.find(f => f.id === 'fog-1')!.status).toBe('resolved');
    expect(map.fog.find(f => f.id === 'fog-2')!.status).toBe('open'); // 只重调该题
    expect(map.decisions).toHaveLength(1);
    expect(map.decisions[0].summary).toBe('改判：用 Postgres');

    const meta = metaOf((await wuService.getById(wu.id))!.metadata);
    expect(meta.pendingReplies![0]).toContain('打回重议「部署形态？」');
  });

  it('幂等：fog 已 resolved 且同结论不双写 decisions[]', async () => {
    const project = await createProject();
    const wu = await createRulingWu(project);
    await projectService.update(project.id, {
      map: {
        destination: project.title,
        decisions: [{ wuId: wu.id, summary: 'SQLite', resolvedAt: '2026-09-09T00:00:00Z' }],
        fog: [{ id: 'fog-1', question: '存储选型？', wuId: null, status: 'resolved' }],
      } satisfies PmoMap,
    });

    await applyPlanRuling(wu.id, [
      { question: '存储选型？', action: 'accept', conclusion: 'SQLite' },
    ], fileStore);

    const map = (await projectService.get(project.id))!.map!;
    expect(map.decisions).toHaveLength(1); // 不双写
  });

  it('无 pmoId：只复活同会话，不写台账不炸', async () => {
    const wu = await createRulingWu();

    const updated = await applyPlanRuling(wu.id, [
      { question: '存储选型？', action: 'accept', conclusion: 'SQLite' },
    ], fileStore);

    expect(updated.status).toBe('active');
    const meta = metaOf(updated.metadata);
    expect(meta.pendingReplies![0]).toContain('采纳「存储选型？」：SQLite');
    expect(meta.planRulings).toBeUndefined();
  });

  it('拒绝：非 blocked / 无待裁 rulings', async () => {
    const project = await createProject();
    const active = await wuService.create({
      type: 'plan', scope: 'x', channelId: 'ch-test', status: 'active',
      metadata: { pmoId: project.id, planRulings: RULINGS },
    });
    await expect(applyPlanRuling(active.id, [
      { question: '存储选型？', action: 'accept', conclusion: 'SQLite' },
    ], fileStore)).rejects.toThrow(/blocked/);

    const noRulings = await wuService.create({
      type: 'plan', scope: 'y', channelId: 'ch-test', status: 'blocked',
      metadata: { pmoId: project.id, waitingForInput: true },
    });
    await expect(applyPlanRuling(noRulings.id, [
      { question: '存储选型？', action: 'accept', conclusion: 'SQLite' },
    ], fileStore)).rejects.toThrow(/ruling/i);
  });
});

describe('#467 validateRulingItems：载荷校验', () => {
  it('合法载荷原样通过（含 reopen 无结论）', () => {
    expect(validateRulingItems([
      { question: 'q1', action: 'accept', conclusion: 'c1' },
      { question: 'q2', action: 'reopen' },
    ])).toEqual([
      { question: 'q1', action: 'accept', conclusion: 'c1' },
      { question: 'q2', action: 'reopen' },
    ]);
  });

  it('非法载荷抛 PlanRulingError', () => {
    expect(() => validateRulingItems(undefined)).toThrow(PlanRulingError);
    expect(() => validateRulingItems([])).toThrow(PlanRulingError);
    expect(() => validateRulingItems([{ question: '', action: 'accept', conclusion: 'c' }])).toThrow(PlanRulingError);
    expect(() => validateRulingItems([{ question: 'q', action: 'accept' }])).toThrow(PlanRulingError); // 采纳缺结论
    expect(() => validateRulingItems([{ question: 'q', action: 'accept', conclusion: '  ' }])).toThrow(PlanRulingError);
    expect(() => validateRulingItems([{ question: 'q', action: 'maybe' }])).toThrow(PlanRulingError);
    const tooMany = Array.from({ length: 13 }, (_, i) => ({ question: `q${i}`, action: 'reopen' }));
    expect(() => validateRulingItems(tooMany)).toThrow(PlanRulingError);
  });
});
