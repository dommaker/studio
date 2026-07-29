// Assignee-aware claiming：AgentLoop.observe() 按 assigneeId 过滤可认领 WorkUnit
// （@mention 语义，docs/vision-2026.md §3）。
// 规则：status=unassigned 且 (assigneeId === 本 loop 的 profile id，或未指派且在本
// profile 频道作用域内)。mkdir-flock 原子认领保持为第二道防线（不在此测试）。
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

import { AgentLoop, resolveTarget } from '../agent-loop';

const SELF_ROLE_ID = 'role-self';
const OTHER_ROLE_ID = 'role-other';
const SELF_INSTANCE_ID = 'instance-self';
const MY_CHANNEL = 'ch-mine';
const OTHER_CHANNEL = 'ch-other';

const mockRole = {
  id: SELF_ROLE_ID,
  name: 'self-agent',
  description: 'task executor (assignee test)', // 决策 9：description 不再解析 acceptedTypes
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

describe('Assignee-aware claiming（observe 过滤）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let agentLoop: AgentLoop;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-assignee-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    // 不 start()：避免后台 runLoop 并发认领造成断言抖动；直接注入 instance
    // （myActive 作用域 = assigneeId === instance.id，与运行中的 loop 一致）。
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

  it('(a) 指派给其他 profile 的 WorkUnit 不被本 loop 认领（即使同频道）', async () => {
    const wu = await wuService.create({
      scope: '@other-agent 实现登录', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: OTHER_ROLE_ID,
    });

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).not.toContain(wu.id);
    expect(resolveTarget(obs)).toBeNull();
  });

  it('(b) 指派给本 profile 的 WorkUnit 被本 loop 认领并续跑', async () => {
    const wu = await wuService.create({
      scope: '@self-agent 实现登录', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: SELF_ROLE_ID,
    });

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).toContain(wu.id);

    const target = resolveTarget(obs);
    expect(target?.workUnit.id).toBe(wu.id);

    // 认领（与 runLoop 相同的路径）：flock claim → active + assigneeId=instanceId
    const claimed = await wuService.claim(target!.workUnit.id, SELF_INSTANCE_ID);
    expect(claimed.status).toBe('active');
    expect(claimed.assigneeId).toBe(SELF_INSTANCE_ID);

    // 认领后进入 myActive（同一 loop 继续执行；F5 resume 亦经此路径拾取）
    const obs2 = await observe();
    expect(obs2.myActive.map(w => w.id)).toContain(wu.id);
  });

  it('(c) 未指派且在本频道的 WorkUnit 仍被认领（既有行为保持）', async () => {
    const wu = await wuService.create({
      scope: '普通任务', channelId: MY_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
    });

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).toContain(wu.id);
    expect(resolveTarget(obs)?.workUnit.id).toBe(wu.id);
  });

  it('(c2) 决策 10：删除 acceptedTypes 硬过滤 —— acceptedTypes 不含 WU type 的任务仍可见', async () => {
    // 角色只声明 implement，但 type=review 的任务（指派 + 频道未指派各一）都必须可见
    const loop = new AgentLoop({ ...mockRole, acceptedTypes: ['implement'] }, fileStore);
    (loop as unknown as { instance: unknown }).instance = {
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
    const assigned = await wuService.create({
      scope: '@self-agent 审查代码', channelId: MY_CHANNEL, type: 'review',
      status: 'unassigned', assigneeId: SELF_ROLE_ID,
    });
    const channelScoped = await wuService.create({
      scope: '频道内审查任务', channelId: MY_CHANNEL, type: 'review',
      status: 'unassigned', assigneeId: null,
    });

    const obs = await (loop as unknown as ObserveCapable).observe();
    expect(obs.unassigned.map(w => w.id)).toContain(assigned.id);
    expect(obs.unassigned.map(w => w.id)).toContain(channelScoped.id);
  });

  it('(d) 未指派但在非本 profile 频道的 WorkUnit 不被认领', async () => {
    const wu = await wuService.create({
      scope: '其他频道的任务', channelId: OTHER_CHANNEL, type: 'task',
      status: 'unassigned', assigneeId: null,
    });

    const obs = await observe();
    expect(obs.unassigned.map(w => w.id)).not.toContain(wu.id);
    expect(resolveTarget(obs)).toBeNull();
  });

  it('(d2) F4 评审排除实现者：metadata.excludeAssignee=本 profile 的未指派 WU 不可见；排除他人则可见', async () => {
    const excluded = await wuService.create({
      scope: '审查代码变更：我实现的活', channelId: MY_CHANNEL, type: 'review',
      status: 'unassigned', assigneeId: null,
      metadata: { excludeAssignee: SELF_ROLE_ID },
    });
    const notExcluded = await wuService.create({
      scope: '审查代码变更：别人实现的活', channelId: MY_CHANNEL, type: 'review',
      status: 'unassigned', assigneeId: null,
      metadata: { excludeAssignee: OTHER_ROLE_ID },
    });
    const selfReviewFallback = await wuService.create({
      scope: '审查代码变更：自评兜底', channelId: MY_CHANNEL, type: 'review',
      status: 'unassigned', assigneeId: null,
      metadata: { selfReview: true }, // 自评兜底不设 excludeAssignee → 可见
    });

    const obs = await observe();
    const ids = obs.unassigned.map(w => w.id);
    expect(ids).not.toContain(excluded.id);
    expect(ids).toContain(notExcluded.id);
    expect(ids).toContain(selfReviewFallback.id);
  });

  it('(e) myActive 作用域：仅拾取 assigneeId === 本实例 id 的 active/blocked WorkUnit', async () => {
    const mine = await wuService.create({
      scope: '我的进行中任务', channelId: MY_CHANNEL, type: 'task',
      status: 'active', assigneeId: SELF_INSTANCE_ID,
    });
    const others = await wuService.create({
      scope: '其他实例的进行中任务', channelId: MY_CHANNEL, type: 'task',
      status: 'active', assigneeId: 'instance-other',
    });

    const obs = await observe();
    expect(obs.myActive.map(w => w.id)).toContain(mine.id);
    expect(obs.myActive.map(w => w.id)).not.toContain(others.id);
  });
});
