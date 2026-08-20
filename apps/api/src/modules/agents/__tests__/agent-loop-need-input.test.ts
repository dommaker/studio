// F5 双向沟通：AgentLoop NEED_INPUT 挂起 + 人类回复注入 prompt
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行（executeLightweight）与 knowledge-service mock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

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
import { resumeWaitingWorkUnit } from '../../workunit/waiting-input.js';

const mockRole = {
  id: 'role-f5',
  name: 'f5-agent',
  description: 'F5 test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface RecordResultCapable {
  recordResult(target: unknown, result: unknown): Promise<void>;
  agentStep(target: unknown): Promise<{ action: string; summary: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
}

describe('F5: NEED_INPUT 挂起与恢复', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-f5-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-f5-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#f5-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // 不 start()：recordResult/agentStep 不依赖运行中的 loop 实例
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** 创建 active WorkUnit + anchor 消息（@mention 派发形态） */
  async function setupDispatchedWorkUnit() {
    const wu = await wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-1',
    });
    const anchor: ChannelMessageData = {
      id: uuidv4(), channelId, authorType: 'human', agentName: null,
      content: '@f5-agent 实现登录功能', replyToId: null, meta: '{}',
      workUnitId: wu.id, createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, anchor);
    return { wu, anchor };
  }

  it('(a) NEED_INPUT → WorkUnit 挂起 blocked + 问题发到频道 + 不会被重新认领', async () => {
    const { wu, anchor } = await setupDispatchedWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '使用 OAuth 还是账号密码？' },
    );

    // 挂起：blocked + waiting 元数据
    const parked = (await wuService.getById(wu.id))!;
    expect(parked.status).toBe('blocked');
    const meta: WorkUnitMetadata = JSON.parse(parked.metadata!);
    expect(meta.waitingForInput).toBe(true);
    expect(meta.waitingQuestion).toBe('使用 OAuth 还是账号密码？');
    expect(meta.waitingSince).toBeTruthy();
    expect(meta.waitingReminded).toBe(false);

    // 问题作为 agent 消息发进频道（挂在同一线程，带 workUnitId 供回复继承）
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const question = messages.find(m => m.authorType === 'agent' && m.content.includes('需要输入'));
    expect(question).toBeDefined();
    expect(question!.content).toContain('使用 OAuth 还是账号密码？');
    expect(question!.agentName).toBe('f5-agent');
    expect(question!.replyToId).toBe(anchor.id);

    // 不会被 loop 重新认领/执行
    expect(resolveTarget({ myActive: [parked], unassigned: [], newReplies: [] })).toBeNull();
    await expect(wuService.claim(wu.id, 'other-instance')).rejects.toThrow();
  });

  it('(a2) 已挂起 WorkUnit 再次 NEED_INPUT 不抛错（blocked → blocked 守卫）', async () => {
    const { wu } = await setupDispatchedWorkUnit();
    const loop = agentLoop as unknown as RecordResultCapable;

    await loop.recordResult({ workUnit: wu }, { action: 'need_input', summary: '问题 1' });
    await expect(
      loop.recordResult({ workUnit: wu }, { action: 'need_input', summary: '问题 2' }),
    ).resolves.toBeUndefined();

    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
  });

  it('(a3) #279：need_input 带 options → 提问消息 meta 携带结构化选项', async () => {
    const { wu } = await setupDispatchedWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '选哪个方案？', options: [{ label: 'A', value: 'a' }, { label: 'B' }] },
    );

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const question = messages.find(m => m.authorType === 'agent' && m.content.includes('需要输入'));
    expect(question).toBeDefined();
    const meta = JSON.parse(question!.meta as string);
    expect(meta.options).toEqual([{ label: 'A', value: 'a' }, { label: 'B' }]);
  });

  it('(b) 人类回复 → 恢复 active，回复文本注入下一轮 agent prompt', async () => {
    const { wu } = await setupDispatchedWorkUnit();
    const loop = agentLoop as unknown as RecordResultCapable;

    await loop.recordResult({ workUnit: wu }, { action: 'need_input', summary: '使用 OAuth 还是账号密码？' });
    await resumeWaitingWorkUnit(wu.id, '用 OAuth，只接 Google', fileStore);

    const resumed = (await wuService.getById(wu.id))!;
    expect(resumed.status).toBe('active');

    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:继续实现',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    const stepResult = await loop.agentStep({ workUnit: resumed });

    const prompt = mockExecuteLightweight.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('人类新回复');
    expect(prompt).toContain('用 OAuth，只接 Google');
    // 注入后即消费，避免后续步骤重复注入
    expect(stepResult.metadataUpdates).toHaveProperty('pendingReplies', undefined);

    await loop.recordResult({ workUnit: resumed }, stepResult);
    const after = (await wuService.getById(wu.id))!;
    const meta: WorkUnitMetadata = JSON.parse(after.metadata!);
    expect(meta.pendingReplies).toBeUndefined();
    expect(meta.waitingForInput).toBeFalsy();
  });
});
