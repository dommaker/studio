// #221（#214 决议）：认领陈旧守卫 —— observe() 可见性层拦截。
// updatedAt 距今 > 72h 的 unassigned WU（含显式指名）对任何 loop 不可见，
// 状态不动、不写事件流；updatedAt 被任何写刷新后恢复可认领（复活零新增机制）。
// 告警侧（stale_claim_guard 探针）由 monitor-probes.test.ts 覆盖。
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 knowledge-service mock。
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

import { AgentLoop, resolveTarget } from '../loop/agent-loop';

const SELF_ROLE_ID = 'role-self';
const SELF_INSTANCE_ID = 'instance-self';
const MY_CHANNEL = 'ch-mine';

const STALE_MS = 72 * 60 * 60 * 1000 + 60 * 1000; // 72h + 1min

const mockRole = {
  id: SELF_ROLE_ID,
  name: 'self-agent',
  description: 'task executor (stale claim guard test)',
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

describe('认领陈旧守卫（#221：observe 可见性层拦截）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let agentLoop: AgentLoop;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-stale-guard-'));
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

  /** 把已建 WU 的 updatedAt 回填为陈旧（模拟沉睡 >72h 的僵尸 WU） */
  async function backdateUpdatedAt(wuId: string, staleMs: number): Promise<string> {
    const snap = (await fileStore.getIndex()).find(s => s.id === wuId);
    if (!snap) throw new Error(`wu ${wuId} not found`);
    const staleIso = new Date(Date.now() - staleMs).toISOString();
    await fileStore.upsertSnapshot({ ...snap, updatedAt: staleIso });
    return staleIso;
  }

  it('(a) 陈旧未指派 WU 不可见、不认领，状态与事件流零变化', async () => {
    const wu = await wuService.create({
      scope: '沉睡的普通任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
    });
    const staleIso = await backdateUpdatedAt(wu.id, STALE_MS);

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).not.toContain(wu.id);
    expect(resolveTarget(obs)).toBeNull();

    // 状态不动、不写事件流 WU 状态（observe 纯过滤无副作用）
    const snap = (await fileStore.getIndex()).find(s => s.id === wu.id)!;
    expect(snap.status).toBe('unassigned');
    expect(snap.updatedAt).toBe(staleIso);
  });

  it('(b) 陈旧 + 显式指名本 profile 的 WU 同样被拦截', async () => {
    const wu = await wuService.create({
      scope: '@self-agent 沉睡的指名任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: SELF_ROLE_ID,
    });
    await backdateUpdatedAt(wu.id, STALE_MS);

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).not.toContain(wu.id);
    expect(resolveTarget(obs)).toBeNull();
  });

  it('(c) 72h 内的 unassigned WU 认领行为完全不受影响', async () => {
    const wu = await wuService.create({
      scope: '新鲜任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
    });
    // 71h59min —— 阈值内，仍可见
    await backdateUpdatedAt(wu.id, STALE_MS - 2 * 60 * 1000);

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).toContain(wu.id);
    expect(resolveTarget(obs)?.workUnit.id).toBe(wu.id);
  });

  it('(d) updatedAt 被写刷新后复活：恢复可见可认领（零新增机制）', async () => {
    const wu = await wuService.create({
      scope: '先睡后醒的任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
    });
    await backdateUpdatedAt(wu.id, STALE_MS);
    expect((await observe()).unassigned.map(w => w.id)).not.toContain(wu.id);

    // 任何写操作刷新 updatedAt（此处以 metadata 合并写模拟人工介入）
    await fileStore.updateMetadata(wu.id, cur => ({ ...cur, humanTouched: true }));

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).toContain(wu.id);
    expect(resolveTarget(obs)?.workUnit.id).toBe(wu.id);
  });
});
