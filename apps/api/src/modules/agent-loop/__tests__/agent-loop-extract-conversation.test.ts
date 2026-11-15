// R3: AgentLoop COMPLETE → extractFromConversation 触发（fire-and-forget）+ 去重 + 失败吞咽
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；executeLightweight 与 knowledge-service mock
// （约定同 agent-loop-need-input.test.ts）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../../workunit/workunit-review.js';
import type { WorkUnitMetadata } from '../../workunit/workunit.types.js';
import type { WorkUnitData } from '../../workunit/workunit-crud.js';

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

vi.mock('../../knowledge/knowledge-service', () => {
  const knowledgeService = {
    injectContext: mockInjectContext,
    recordOutcome: mockRecordOutcome,
    extractFromExecution: mockExtractFromExecution,
    extractFromConversation: mockExtractFromConversation,
  };
  return {
    knowledgeService,
    knowledgePorts: { consume: knowledgeService, produce: knowledgeService, track: knowledgeService },
  };
});

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

  it('(c) COMPLETE → 持久化知识提取 Effect，成功由 Receipt 表达而非提前写哨兵', async () => {
    const wu = await createActiveWu({ pendingReplies: ['用 OAuth 实现'] });
    mockCompleteOutput();

    const result = await (agentLoop).agentStep({ workUnit: wu });
    await agentLoop.recordResult({ workUnit: wu }, result);

    expect(result.action).toBe('complete');
    expect(result.metadataUpdates?.knowledgeExtractedAt).toBeUndefined();
    await vi.waitFor(async () => {
      const snapshot = (await fileStore.getIndex({ id: wu.id }))[0];
      expect(snapshot?.effects?.find(effect => effect.kind === 'knowledge-extraction')?.status).toBe('succeeded');
    });
    const snapshot = (await fileStore.getIndex({ id: wu.id }))[0];
    const effect = snapshot?.effects?.find(item => item.kind === 'knowledge-extraction');
    expect(effect).toMatchObject({
      workUnitId: wu.id,
      idempotencyKey: `knowledge-extraction:${wu.id}:${result.assignmentId}`,
      attempts: 1,
    });
    expect(snapshot?.effectReceipts?.some(receipt => receipt.effectId === effect?.id && receipt.outcome === 'succeeded')).toBe(true);
    expect(mockExtractFromConversation).toHaveBeenCalledTimes(1);
    const [, ctx] = mockExtractFromConversation.mock.calls[0];
    expect(ctx).toMatchObject({
      workUnitId: wu.id,
      assignmentId: result.assignmentId,
      extractionVersion: 'conversation-1',
      revision: 1,
      scope: { kind: 'role', id: mockRole.id },
      outcome: { execution: 'succeeded', delivery: 'unmerged' },
    });
    expect(ctx.stepRecordId).toBeTruthy();

    // R3 兜底独立性：模板提取 extractFromExecution 照常触发（fire-and-forget，等 microtask 排空）
    await new Promise(r => setImmediate(r));
    expect(mockExtractFromExecution).toHaveBeenCalledWith(expect.objectContaining({
      consumedKnowledge: [],
      learning: expect.objectContaining({
        workUnitId: wu.id,
        assignmentId: result.assignmentId,
        stepRecordId: ctx.stepRecordId,
        transcriptRefs: expect.any(Array),
        evidenceRefs: expect.any(Array),
        extractionVersion: 'execution-1',
      }),
    }));
  });

  it('非 COMPLETE（PROGRESS）不触发提取', async () => {
    const wu = await createActiveWu();
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });

    const result = await (agentLoop).agentStep({ workUnit: wu });

    expect(result.action).toBe('progress');
    expect(mockExtractFromConversation).not.toHaveBeenCalled();
    expect(result.metadataUpdates?.knowledgeExtractedAt).toBeUndefined();
  });

  it('临时提取失败不阻断 complete，Effect 落 retry-after 与 retrying Receipt', async () => {
    const wu = await createActiveWu();
    mockCompleteOutput();
    mockExtractFromConversation.mockRejectedValueOnce(new Error('LLM down'));

    const result = await (agentLoop).agentStep({ workUnit: wu });
    await agentLoop.recordResult({ workUnit: wu }, result);

    expect(result.action).toBe('complete');
    expect(result.summary).toBe('登录功能已完成');
    await vi.waitFor(async () => {
      const snapshot = (await fileStore.getIndex({ id: wu.id }))[0];
      const effect = snapshot?.effects?.find(item => item.kind === 'knowledge-extraction');
      expect(effect).toMatchObject({ status: 'queued', attempts: 1, lastError: expect.stringContaining('LLM down') });
      expect(effect?.nextAttemptAt).toBeTruthy();
      expect(snapshot?.effectReceipts?.some(receipt => receipt.effectId === effect?.id && receipt.outcome === 'retrying')).toBe(true);
    });
  });

  it('legacy knowledgeExtractedAt 不再冒充成功，仍补建持久 Effect', async () => {
    const wu = await createActiveWu({ knowledgeExtractedAt: new Date().toISOString() });
    mockCompleteOutput();

    const result = await (agentLoop).agentStep({ workUnit: wu });
    await agentLoop.recordResult({ workUnit: wu }, result);

    expect(result.action).toBe('complete');
    await vi.waitFor(async () => {
      const snapshot = (await fileStore.getIndex({ id: wu.id }))[0];
      expect(snapshot?.effects?.find(effect => effect.kind === 'knowledge-extraction')?.status).toBe('succeeded');
    });
    expect(mockExtractFromConversation).toHaveBeenCalledTimes(1);
    expect(result.metadataUpdates?.knowledgeExtractedAt).toBeUndefined();
  });
});
