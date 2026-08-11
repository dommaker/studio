// #109（T3，#106 子票）M4 接单过滤：AgentLoop.observe() 的 unassigned 可见性增加
// blockedBy 依赖门禁 —— metadata.blockedBy 中有未 done 的 WU → 该任务单对所有 loop 不可见。
// 依赖关系可跨 PMO（FileStore 全局 index 判定，不限本频道/本 PMO）。
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 knowledge-service mock
// （harness 同 agent-loop-assignee.test.ts）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../../workunit/workunit.service.js';

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop } from '../loop/agent-loop';

const SELF_ROLE_ID = 'role-self';
const SELF_INSTANCE_ID = 'instance-self';
const MY_CHANNEL = 'ch-mine';
const OTHER_CHANNEL = 'ch-other';

const mockRole = {
  id: SELF_ROLE_ID,
  name: 'self-agent',
  description: 'task executor (blockedBy test)',
  channels: JSON.stringify([MY_CHANNEL]),
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface ObserveCapable {
  observe(): Promise<{
    myActive: WorkUnitData[];
    unassigned: WorkUnitData[];
    newReplies: unknown[];
  }>;
}

describe('M4 接单过滤（blockedBy 依赖门禁）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let agentLoop: AgentLoop;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-blocked-by-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    agentLoop = new AgentLoop(mockRole, fileStore);
    (agentLoop as unknown as { instance: unknown }).instance = {
      id: SELF_INSTANCE_ID,
      roleId: SELF_ROLE_ID,
      sessionId: null,
      status: 'idle',
      currentWorkUnitId: null,
      startedAt: new Date().toISOString(),
      terminatedAt: null,
      lastHeartbeat: null,
      metadata: null,
    };
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function observe() {
    return (agentLoop as unknown as ObserveCapable).observe();
  }

  it('(a) 依赖未完成（active）→ 任务单不可见', async () => {
    const blocker = await wuService.create({
      scope: '前置任务', channelId: MY_CHANNEL, type: 'task',
      status: 'active', assigneeId: 'instance-other',
    });
    const target = await wuService.create({
      scope: '后续任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
      metadata: { blockedBy: [blocker.id] },
    });

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).not.toContain(target.id);
  });

  it('(b) 依赖 done → 任务单可见', async () => {
    const blocker = await wuService.create({
      scope: '已完成的前置任务', channelId: MY_CHANNEL, type: 'task',
      status: 'done', assigneeId: 'instance-other',
    });
    const target = await wuService.create({
      scope: '后续任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
      metadata: { blockedBy: [blocker.id] },
    });

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).toContain(target.id);
  });

  it('(c) 跨 PMO 依赖生效：blocker 在其他频道/PMO 且未 done → 不可见；done → 可见', async () => {
    // blocker 不属于本频道、归属另一个 PMO —— 全局 index 判定天然跨 PMO
    const blockerOtherPmo = await wuService.create({
      scope: '其他 PMO 的前置任务', channelId: OTHER_CHANNEL, type: 'task',
      status: 'active', assigneeId: 'instance-other',
      metadata: { pmoId: 'pmo-other' },
    });
    const blocked = await wuService.create({
      scope: '跨 PMO 被阻塞任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
      metadata: { blockedBy: [blockerOtherPmo.id], pmoId: 'pmo-mine' },
    });
    const blockerDoneOtherPmo = await wuService.create({
      scope: '其他 PMO 的已完成前置任务', channelId: OTHER_CHANNEL, type: 'task',
      status: 'done', assigneeId: 'instance-other',
      metadata: { pmoId: 'pmo-other' },
    });
    const unblocked = await wuService.create({
      scope: '跨 PMO 已解锁任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
      metadata: { blockedBy: [blockerDoneOtherPmo.id], pmoId: 'pmo-mine' },
    });

    const obs = await observe();
    const ids = obs.unassigned.map(w => w.id);
    expect(ids).not.toContain(blocked.id);
    expect(ids).toContain(unblocked.id);
  });

  it('(d) 无 blockedBy → 行为同现状（可见）', async () => {
    const plain = await wuService.create({
      scope: '普通任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
    });
    const emptyDeps = await wuService.create({
      scope: '空依赖任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
      metadata: { blockedBy: [] },
    });

    const obs = await observe();
    const ids = obs.unassigned.map(w => w.id);
    expect(ids).toContain(plain.id);
    expect(ids).toContain(emptyDeps.id);
  });

  it('(e) blockedBy 引用缺失 id（已删除/笔误）→ 保守不可见', async () => {
    const target = await wuService.create({
      scope: '依赖不存在任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
      metadata: { blockedBy: ['wu-not-exist'] },
    });

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).not.toContain(target.id);
  });
});
