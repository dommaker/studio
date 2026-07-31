// 2026-07 PMO-flow UX（§6-2）：instance 忙闲 SSE（agent.instance.status_changed）
// 覆盖：进入 idle 发一次且信封形状正确 / 45s 节流重入 idle 不重发 /
//       idle→active→idle 状态变化各发一次、同状态连发去重 / instance 缺失不发。
// 模式同 agent-loop-need-input.test.ts：真实 FileStore（tmpdir），CLI 执行与 knowledge-service mock；
// eventStore.publish 用 vi.spyOn 观察（单例，call-through 到内存 eventBus 无副作用）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

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

import { AgentLoop } from '../agent-loop';
import { eventStore } from '../../../core/event-store.js';

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
  instance: { id: string } | null;
  updateIdleState(): Promise<void>;
  publishInstanceStatus(status: string, currentWorkUnitId: string | null): void;
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
  };
}

function statusEvents(spy: ReturnType<typeof vi.spyOn>): StatusEvent[] {
  return spy.mock.calls
    .map(call => {
      try {
        return JSON.parse(call[1] as string) as StatusEvent;
      } catch {
        return null;
      }
    })
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
    publishSpy = vi.spyOn(eventStore, 'publish');
    (loop as unknown as StatusSseCapable).instance = { id: 'inst-sse-1' };
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

    await capable.updateIdleState();                       // idle（首发）
    capable.publishInstanceStatus('active', 'wu-1');       // → active（变化，发）
    capable.publishInstanceStatus('active', 'wu-1');       // 同状态（去重）
    await capable.updateIdleState();                       // → idle（变化，发）

    const events = statusEvents(publishSpy);
    expect(events.map(e => e.data.status)).toEqual(['idle', 'active', 'idle']);
    expect(events[1].data.currentWorkUnitId).toBe('wu-1');
    expect(events[1].data.instanceId).toBe('inst-sse-1');
  });

  it('instance 未初始化时不发布（守卫）', () => {
    const noInstance = new AgentLoop(mockRole, fileStore) as unknown as StatusSseCapable;
    noInstance.publishInstanceStatus('idle', null);

    expect(statusEvents(publishSpy)).toHaveLength(0);
  });
});
