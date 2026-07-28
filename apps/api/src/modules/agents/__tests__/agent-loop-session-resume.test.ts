// fix/guard-and-resume Bug B：agent-loop 会话续用传参
// 新建：claude 把新 sessionId 传给 CLI（--session-id 建会话），无 sessionResume；
// 续用：同一 WU 内（metadata.sessionId === instance.sessionId）→ sessionId + sessionResume: true；
// 跨 WU（instance 带着别的 WU 的 sessionId）→ 按新建处理（claude 会话按 cwd 存储，跨 worktree 必失败）；
// 首 step 执行失败 → 重置 sessionId（不 --resume 一个从未建立的会话）。
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 workspace 解析 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';
import type { AgentTask } from '@dommaker/studio-agent';

const { mockResolveWorkspaceRoot } = vi.hoisted(() => ({
  mockResolveWorkspaceRoot: vi.fn(),
}));

vi.mock('../../workspaces/workspace-store', () => ({
  resolveWorkspaceRoot: mockResolveWorkspaceRoot,
}));

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

const mockRole = {
  id: 'role-resume',
  name: 'resume-agent',
  description: 'session resume test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface AgentStepCapable {
  agentStep(target: unknown): Promise<{ action: string; summary: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
  recordResult(target: unknown, result: unknown): Promise<void>;
}

interface InstanceHolder {
  instance: { id: string; sessionId: string | null } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Bug B: agent-loop 会话续用传参（sessionResume）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-resume-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-resume-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#resume-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
    mockResolveWorkspaceRoot.mockResolvedValue('/tmp/fake-worktree');
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:继续',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function setupWorkUnit(metadata?: WorkUnitMetadata) {
    const wu = await wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-1', workspaceId: 'ws-1',
      ...(metadata ? { metadata } : {}),
    });
    const anchor: ChannelMessageData = {
      id: 'anchor-1', channelId, authorType: 'human', agentName: null,
      content: '@resume-agent 实现登录功能', replyToId: null, meta: '{}',
      workUnitId: wu.id, createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, anchor);
    return wu;
  }

  /** 注入带 sessionId 的 RuntimeInstance（FileStore 里建真 state，updateState 才能落盘） */
  async function injectInstance(sessionId: string | null): Promise<string> {
    const instanceId = 'inst-resume-1';
    await fileStore.createState(instanceId, {
      id: instanceId, roleId: mockRole.id, sessionId,
      status: 'idle', currentWorkUnitId: null,
      startedAt: new Date().toISOString(), terminatedAt: null,
      lastHeartbeat: null, metadata: null, pid: process.pid,
    });
    (agentLoop as unknown as InstanceHolder).instance = {
      id: instanceId, sessionId,
    } as InstanceHolder['instance'];
    return instanceId;
  }

  function lastTask(): AgentTask {
    return mockExecuteLightweight.mock.calls.at(-1)![0] as AgentTask;
  }

  it('新建（instance 无 sessionId）→ claude 传新 sessionId，无 sessionResume', async () => {
    await injectInstance(null);
    const wu = await setupWorkUnit();

    await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    const task = lastTask();
    expect(task.parameters?.sessionId).toMatch(UUID_RE);
    expect(task.parameters?.sessionResume).toBeUndefined();
  });

  it('同一 WU 第二步（metadata.sessionId === instance.sessionId）→ 续用：sessionId + sessionResume: true', async () => {
    await injectInstance('sess-wu1');
    const wu = await setupWorkUnit({ sessionId: 'sess-wu1' });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    const task = lastTask();
    expect(task.parameters?.sessionId).toBe('sess-wu1');
    expect(task.parameters?.sessionResume).toBe(true);
    expect(step.metadataUpdates?.sessionResumes).toBe(1);
    // 续用不重新签发 sessionId
    expect(step.metadataUpdates).not.toHaveProperty('sessionId');
  });

  it('跨 WU（instance 带着别的 WU 的 sessionId，本 WU metadata 无）→ 按新建处理', async () => {
    const instanceId = await injectInstance('sess-other-wu');
    const wu = await setupWorkUnit();

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    const task = lastTask();
    expect(task.parameters?.sessionResume).toBeUndefined();
    expect(task.parameters?.sessionId).toMatch(UUID_RE);
    expect(task.parameters?.sessionId).not.toBe('sess-other-wu');
    // instance 持久化为新 id
    const state = await fileStore.getState(instanceId);
    expect(state?.sessionId).toBe(task.parameters?.sessionId);
    expect(step.metadataUpdates?.sessionId).toBe(task.parameters?.sessionId);
  });

  it('非 claude provider（kimi）：新建不传 sessionId（CLI 自建会话），续用传 sessionId + sessionResume', async () => {
    const kimiLoop = new AgentLoop({ ...mockRole, provider: 'kimi' } as typeof mockRole, fileStore);
    const instanceId = 'inst-resume-kimi';
    await fileStore.createState(instanceId, {
      id: instanceId, roleId: mockRole.id, sessionId: null,
      status: 'idle', currentWorkUnitId: null,
      startedAt: new Date().toISOString(), terminatedAt: null,
      lastHeartbeat: null, metadata: null, pid: process.pid,
    });
    (kimiLoop as unknown as InstanceHolder).instance = { id: instanceId, sessionId: null } as InstanceHolder['instance'];

    // 新建：不传 sessionId（kimi --session 是续用语义，对未使用 id 会报错）
    // agentStep 生成 sessionId 写入 metadataUpdates，但不持久化 WU metadata（recordResult 负责）。
    // 测试需从 StepResult 取 sessionId，并手动推进 WU metadata 以触发续用判定匹配。
    const wu = await setupWorkUnit();
    const step1 = await (kimiLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });
    expect(lastTask().parameters?.sessionId).toBeUndefined();
    expect(lastTask().parameters?.sessionResume).toBeUndefined();
    const sessionId = step1.metadataUpdates?.sessionId;
    expect(typeof sessionId).toBe('string');

    // 同一 WU 第二步：续用传 sessionId + sessionResume（runner 模板 --session 不变）
    (kimiLoop as unknown as InstanceHolder).instance!.sessionId = sessionId!;
    // 手动持久化 sessionId 到 WU metadata → agentStep 续用判定（metadata.sessionId === instance.sessionId）
    await wuService.update(wu.id, { metadata: { sessionId: sessionId! } });
    const wu2 = (await wuService.getById(wu.id))!;
    await (kimiLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu2 });
    expect(lastTask().parameters?.sessionId).toBe(sessionId);
    expect(lastTask().parameters?.sessionResume).toBe(true);
  });

  it('首 step 执行失败 → 重置 sessionId（下一步按新建重试，不 --resume 未建立的会话）', async () => {
    const instanceId = await injectInstance(null);
    const wu = await setupWorkUnit();
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'CLI boom', logFile: '/tmp/log', worktree: '/tmp/wt',
      outputFiles: [], sessionCount: 1,
    });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(step.action).toBe('failed');
    expect(step.metadataUpdates).not.toHaveProperty('sessionId');
    const state = await fileStore.getState(instanceId);
    expect(state?.sessionId).toBeNull();

    // 下一步重新按新建签发
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:继续',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: (await wuService.getById(wu.id))! });
    expect(lastTask().parameters?.sessionId).toMatch(UUID_RE);
    expect(lastTask().parameters?.sessionResume).toBeUndefined();
  });
});
