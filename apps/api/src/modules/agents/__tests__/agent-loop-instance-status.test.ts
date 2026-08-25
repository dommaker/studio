// 2026-07 PMO-flow UX（§6-2）：instance 忙闲 SSE（agent.instance.status_changed）
// 覆盖：进入 idle 发一次且信封形状正确 / 45s 节流重入 idle 不重发 /
//       idle→active→idle 状态变化各发一次、同状态连发去重 / instance 缺失不发。
// #312（SSE 事件负载契约体检）：负载 additive 补 currentWorkUnit 快照（对齐
//       getAgentSummary：title = metadata.title ?? scope，悬空 WU → null 裸 id 保留）+
//       channelId（当前 WU 所在频道）+ lastError/lastErrorAt；发布面扩到 error（启动失败路径）。
// 模式同 agent-loop-need-input.test.ts：真实 FileStore（tmpdir），CLI 执行与 knowledge-service mock；
// eventBus.publish 用 vi.spyOn 观察（单例，call-through 到内存订阅者无副作用）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';

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

const mockRole = {
  id: 'role-sse',
  name: 'sse-agent',
  description: 'SSE test agent',
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** 测试触达 private 成员的结构接口（as unknown as 转换，同 agent-loop-need-input 模式） */
interface StatusSseCapable {
  instance: { id: string; startedAt?: string | null; lastError?: string | null; lastErrorAt?: string | null } | null;
  updateIdleState(): Promise<void>;
  publishInstanceStatus(status: string, currentWorkUnitId: string | null): Promise<void>;
  recordStartupFailure(message: string): Promise<void>;
}

interface StatusEvent {
  event_type: string;
  event_id: string;
  timestamp: string;
  data: {
    profileId: string;
    instanceId: string;
    name: string;
    status: string;
    currentWorkUnitId: string | null;
    currentWorkUnit: {
      id: string;
      title: string;
      type: string;
      status: string;
      claimedAt: string | null;
    } | null;
    channelId: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    /** #318（additive）：instance 启动时刻（AgentDetailPage 运行时长就地更新） */
    startedAt: string | null;
    /** #318（additive）：归属 PMO 快照（同 getAgentSummary 解析链；无当前 WU/无归属 → null） */
    pmo: { id: string; pmoNumber: string; title: string } | null;
  };
}

function statusEvents(spy: ReturnType<typeof vi.spyOn>): StatusEvent[] {
  return spy.mock.calls
    .map(call => call[1] as StatusEvent)
    .filter((e): e is StatusEvent => e?.event_type === 'agent.instance.status_changed');
}

describe('AgentLoop instance 忙闲 SSE（2026-07 §6-2）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let loop: AgentLoop;
  let publishSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-sse-'));
    fileStore = new FileStore(testDir);
    loop = new AgentLoop(mockRole, fileStore);
    publishSpy = vi.spyOn(eventBus, 'publish');
    (loop as unknown as StatusSseCapable).instance = { id: 'inst-sse-1', startedAt: '2026-08-24T02:00:00Z' };
  });

  afterEach(() => {
    publishSpy.mockRestore();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('updateIdleState → 发一次 agent.instance.status_changed，信封形状正确', async () => {
    await (loop as unknown as StatusSseCapable).updateIdleState();

    const events = statusEvents(publishSpy);
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.event_id).toBeTruthy();
    expect(evt.timestamp).toBeTruthy();
    expect(evt.data).toEqual({
      profileId: 'role-sse',
      instanceId: 'inst-sse-1',
      name: 'sse-agent',
      status: 'idle',
      currentWorkUnitId: null,
      // #312：idle 无当前 WU → 快照/频道 null；无错误记录 → lastError 系 null
      currentWorkUnit: null,
      channelId: null,
      lastError: null,
      lastErrorAt: null,
      // #318：startedAt 透传 instance 状态；无当前 WU → pmo null
      startedAt: '2026-08-24T02:00:00Z',
      pmo: null,
    });
  });

  it('重复进入 idle（45s 节流心跳分支）不重复发布', async () => {
    const capable = loop as unknown as StatusSseCapable;
    await capable.updateIdleState();
    await capable.updateIdleState();
    await capable.updateIdleState();

    expect(statusEvents(publishSpy)).toHaveLength(1);
  });

  it('idle→active→idle 状态变化各发一次；同状态连发去重', async () => {
    const capable = loop as unknown as StatusSseCapable;

    await capable.updateIdleState();                            // idle（首发）
    await capable.publishInstanceStatus('active', 'wu-1');      // → active（变化，发）
    await capable.publishInstanceStatus('active', 'wu-1');      // 同状态（去重）
    await capable.updateIdleState();                            // → idle（变化，发）

    const events = statusEvents(publishSpy);
    expect(events.map(e => e.data.status)).toEqual(['idle', 'active', 'idle']);
    expect(events[1].data.currentWorkUnitId).toBe('wu-1');
    expect(events[1].data.instanceId).toBe('inst-sse-1');
  });

  it('instance 未初始化时不发布（守卫）', async () => {
    const noInstance = new AgentLoop(mockRole, fileStore) as unknown as StatusSseCapable;
    await noInstance.publishInstanceStatus('idle', null);

    expect(statusEvents(publishSpy)).toHaveLength(0);
  });

  it('#312：active 事件带当前 WU 快照（title = metadata.title ?? scope）+ channelId', async () => {
    await fileStore.upsertSnapshot({
      id: 'wu-sse', parentId: null, type: 'task', scope: '默认 scope',
      assigneeId: 'inst-sse-1', status: 'active', failureType: null, retryCount: 0,
      timeoutAt: null, channelId: 'ch-sse', projectPath: null,
      metadata: JSON.stringify({ title: '实现登录页' }),
      createdAt: '2026-08-24T00:00:00Z', updatedAt: '2026-08-24T01:00:00Z',
      claimedAt: '2026-08-24T00:30:00Z', completedAt: null,
    });

    await (loop as unknown as StatusSseCapable).publishInstanceStatus('active', 'wu-sse');

    const events = statusEvents(publishSpy);
    expect(events).toHaveLength(1);
    expect(events[0].data.currentWorkUnit).toEqual({
      id: 'wu-sse',
      title: '实现登录页',
      type: 'task',
      status: 'active',
      // #318：改走共享出口后 claimedAt 为快照原样透传（对齐 getAgentSummary 口径，不再 toISOString 归一）
      claimedAt: '2026-08-24T00:30:00Z',
    });
    expect(events[0].data.channelId).toBe('ch-sse');
    expect(events[0].data.lastError).toBeNull();
    expect(events[0].data.lastErrorAt).toBeNull();
  });

  it('#312：metadata 无 title → currentWorkUnit.title 回落 scope', async () => {
    await fileStore.upsertSnapshot({
      id: 'wu-notitle', parentId: null, type: 'task', scope: '修 bug',
      assigneeId: 'inst-sse-1', status: 'active', failureType: null, retryCount: 0,
      timeoutAt: null, channelId: null, projectPath: null, metadata: null,
      createdAt: '2026-08-24T00:00:00Z', updatedAt: '2026-08-24T01:00:00Z',
      claimedAt: null, completedAt: null,
    });

    await (loop as unknown as StatusSseCapable).publishInstanceStatus('active', 'wu-notitle');

    const events = statusEvents(publishSpy);
    expect(events[0].data.currentWorkUnit).toEqual({
      id: 'wu-notitle', title: '修 bug', type: 'task', status: 'active', claimedAt: null,
    });
    expect(events[0].data.channelId).toBeNull();
  });

  it('#312：悬空 currentWorkUnitId（WU 已不存在）→ currentWorkUnit/channelId null，裸 id 保留', async () => {
    await (loop as unknown as StatusSseCapable).publishInstanceStatus('active', 'wu-ghost');

    const events = statusEvents(publishSpy);
    expect(events).toHaveLength(1);
    expect(events[0].data.currentWorkUnitId).toBe('wu-ghost');
    expect(events[0].data.currentWorkUnit).toBeNull();
    expect(events[0].data.channelId).toBeNull();
  });

  it('#312：启动失败（error）路径也发 status_changed，带 lastError/lastErrorAt', async () => {
    await (loop as unknown as StatusSseCapable).recordStartupFailure('health probe timeout');

    const events = statusEvents(publishSpy);
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.data.profileId).toBe('role-sse');
    expect(evt.data.name).toBe('sse-agent');
    expect(evt.data.status).toBe('error');
    expect(evt.data.currentWorkUnitId).toBeNull();
    expect(evt.data.currentWorkUnit).toBeNull();
    expect(evt.data.channelId).toBeNull();
    expect(evt.data.lastError).toBe('health probe timeout');
    expect(evt.data.lastErrorAt).toBeTruthy();
    expect(evt.data.instanceId).toBeTruthy();
  });

  it('#318：active 事件带 startedAt 透传 + pmo 字段（WU 无归属 → pmo null）', async () => {
    await fileStore.upsertSnapshot({
      id: 'wu-nopmo', parentId: null, type: 'task', scope: '无归属任务',
      assigneeId: 'inst-sse-1', status: 'active', failureType: null, retryCount: 0,
      timeoutAt: null, channelId: 'ch-sse', projectPath: null, metadata: null,
      createdAt: '2026-08-24T00:00:00Z', updatedAt: '2026-08-24T01:00:00Z',
      claimedAt: null, completedAt: null,
    });

    await (loop as unknown as StatusSseCapable).publishInstanceStatus('active', 'wu-nopmo');

    const events = statusEvents(publishSpy);
    expect(events).toHaveLength(1);
    expect(events[0].data.startedAt).toBe('2026-08-24T02:00:00Z');
    expect(events[0].data.pmo).toBeNull();
  });

  it('#318：error 路径负载同形状（含 startedAt/pmo 键）', async () => {
    await (loop as unknown as StatusSseCapable).recordStartupFailure('boom');

    const evt = statusEvents(publishSpy)[0];
    expect(evt.data.startedAt).toBeTruthy();
    expect(evt.data.pmo).toBeNull();
  });
});
