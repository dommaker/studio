// R3: AgentLoop COMPLETE → extractFromConversation 触发（fire-and-forget）+ 去重 + 失败吞咽
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；executeLightweight 与 knowledge-service mock
// （约定同 agent-loop-need-input.test.ts）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service.js';

const { mockExecuteLightweight, mockInjectContext, mockRecordOutcome, mockExtractFromExecution, mockExtractFromConversation } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
  mockInjectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
  mockRecordOutcome: vi.fn().mockResolvedValue(undefined),
  mockExtractFromExecution: vi.fn().mockResolvedValue(undefined),
  mockExtractFromConversation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: mockInjectContext,
    recordOutcome: mockRecordOutcome,
    extractFromExecution: mockExtractFromExecution,
    extractFromConversation: mockExtractFromConversation,
  },
}));

import { AgentLoop } from '../agent-loop';

const mockRole = {
  id: 'role-r3',
  name: 'r3-agent',
  description: 'R3 test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface AgentStepCapable {
  agentStep(target: unknown): Promise<{ action: string; summary: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
}

describe('R3: COMPLETE → extractFromConversation', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-r3-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-r3-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#r3-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function createActiveWu(metadata?: WorkUnitMetadata): Promise<WorkUnitData> {
    return wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-1',
      ...(metadata ? { metadata } : {}),
    });
  }

  function mockCompleteOutput(summary = '登录功能已完成') {
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: `ACTION: COMPLETE:${summary}`,
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
  }

  it('(c) COMPLETE → 以会话内容触发一次提取（任务 + pendingReplies + 最终结果），并标记 knowledgeExtractedAt', async () => {
    const wu = await createActiveWu({ pendingReplies: ['用 OAuth 实现'] });
    mockCompleteOutput();

    const result = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(result.action).toBe('complete');
    expect(mockExtractFromConversation).toHaveBeenCalledTimes(1);
    const [messages, ctx] = mockExtractFromConversation.mock.calls[0];
    expect(ctx).toEqual({ workUnitId: wu.id });
    expect(messages).toEqual([
      { role: 'user', content: '实现登录功能' },
      { role: 'user', content: '用 OAuth 实现' },
      { role: 'assistant', content: '登录功能已完成' },
    ]);
    // 去重标记随 metadataUpdates 返回（由 recordResult 原子持久化）
    expect(result.metadataUpdates?.knowledgeExtractedAt).toBeTruthy();

    // R3 兜底独立性：模板提取 extractFromExecution 照常触发（fire-and-forget，等 microtask 排空）
    await new Promise(r => setImmediate(r));
    expect(mockExtractFromExecution).toHaveBeenCalled();
  });

  it('非 COMPLETE（PROGRESS）不触发提取', async () => {
    const wu = await createActiveWu();
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });

    const result = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(result.action).toBe('progress');
    expect(mockExtractFromConversation).not.toHaveBeenCalled();
    expect(result.metadataUpdates?.knowledgeExtractedAt).toBeUndefined();
  });

  it('提取失败被吞掉：拒绝的 promise 不影响 complete 步骤结果', async () => {
    const wu = await createActiveWu();
    mockCompleteOutput();
    mockExtractFromConversation.mockRejectedValueOnce(new Error('LLM down'));

    const result = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(result.action).toBe('complete');
    expect(result.summary).toBe('登录功能已完成');
    // 让被拒绝的 promise 走完 catch，确认无未处理拒绝导致进程级问题
    await new Promise(r => setImmediate(r));
  });

  it('去重：metadata.knowledgeExtractedAt 已存在 → 不再触发', async () => {
    const wu = await createActiveWu({ knowledgeExtractedAt: new Date().toISOString() });
    mockCompleteOutput();

    const result = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(result.action).toBe('complete');
    expect(mockExtractFromConversation).not.toHaveBeenCalled();
    // 不重复打标
    expect(result.metadataUpdates?.knowledgeExtractedAt).toBeUndefined();
  });
});
