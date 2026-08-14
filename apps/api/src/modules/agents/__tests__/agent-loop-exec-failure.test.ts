// P0 修复（W-3 接线）：CLI 执行失败（runner 返回 success:false）的显式失败分支
// - agentStep: success:false → action='failed'，errorType/errorDetail 记入 metadataUpdates
// - recordResult: failed 记 consecutiveStuck、不发频道消息；连续 3 次 → blocked 且频道说明失败原因
// - recordResult: progress/complete 的空 summary 不发频道消息
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 knowledge-service mock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
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

import { AgentLoop } from '../loop/agent-loop';
import { knowledgeService } from '../../knowledge/knowledge-service';

const mockRole = {
  id: 'role-w3',
  name: 'w3-agent',
  description: 'W3 test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface RecordResultCapable {
  recordResult(target: unknown, result: unknown): Promise<void>;
  agentStep(target: unknown): Promise<{ action: string; summary: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
}

describe('P0/W-3: CLI 执行失败显式分支', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-w3-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-w3-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#w3-test', type: 'rnd',
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

  async function createActiveWorkUnit() {
    return wuService.create({
      scope: '实现某个功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-1',
    });
  }

  it('agentStep: success:false → action=failed + errorType/errorDetail 记入 metadataUpdates', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'CLI exited with code 1: boom',
      worktree: '/tmp/wt', outputFiles: [], logFile: '/tmp/log', sessionCount: 1,
    });

    const wu = await createActiveWorkUnit();
    const result = await (agentLoop as unknown as RecordResultCapable).agentStep({ workUnit: wu });

    expect(result.action).toBe('failed');
    expect(result.summary).toContain('CLI exited with code 1: boom');
    expect(result.metadataUpdates?.errorType).toBe('execution_failed');
    expect(result.metadataUpdates?.errorDetail).toContain('boom');
    expect(typeof result.metadataUpdates?.errorAt).toBe('string');
  });

  it('#90: agentStep 失败步落 failure outcome（success=false + errorType=execution_failed）', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'CLI exited with code 1: boom',
      worktree: '/tmp/wt', outputFiles: [], logFile: '/tmp/log', sessionCount: 1,
    });

    const wu = await createActiveWorkUnit();
    await (agentLoop as unknown as RecordResultCapable).agentStep({ workUnit: wu });

    expect(knowledgeService.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorType: 'execution_failed',
      details: expect.stringContaining('boom'),
    }));
  });

  it('agentStep: 成功后清除失败标记（errorType/errorDetail/errorAt 置 undefined）', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:继续推进',
      worktree: '/tmp/wt', outputFiles: [], logFile: '/tmp/log', sessionCount: 1,
    });

    const wu = await createActiveWorkUnit();
    const result = await (agentLoop as unknown as RecordResultCapable).agentStep({ workUnit: wu });

    expect(result.action).toBe('progress');
    expect(result.metadataUpdates).toHaveProperty('errorType', undefined);
    expect(result.metadataUpdates).toHaveProperty('errorDetail', undefined);
    expect(result.metadataUpdates).toHaveProperty('errorAt', undefined);
  });

  it('recordResult: failed 记 consecutiveStuck、保持 active、不发频道消息', async () => {
    const wu = await createActiveWorkUnit();
    const loop = agentLoop as unknown as RecordResultCapable;

    await loop.recordResult({ workUnit: wu }, {
      action: 'failed',
      summary: 'CLI 执行失败: boom',
      metadataUpdates: { errorType: 'execution_failed', errorDetail: 'boom', errorAt: new Date().toISOString() },
    });

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('active');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata!);
    expect(meta.consecutiveStuck).toBe(1);
    expect(meta.errorType).toBe('execution_failed');
    expect(meta.errorDetail).toBe('boom');

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.filter(m => m.authorType === 'agent')).toHaveLength(0);
  });

  it('recordResult: 连续 3 次 failed → blocked + 频道消息说明失败原因', async () => {
    const wu = await createActiveWorkUnit();
    const loop = agentLoop as unknown as RecordResultCapable;
    const failed = {
      action: 'failed',
      summary: 'CLI 执行失败: provider quota exhausted',
      metadataUpdates: { errorType: 'execution_failed', errorDetail: 'provider quota exhausted' },
    };

    await loop.recordResult({ workUnit: wu }, failed);
    await loop.recordResult({ workUnit: wu }, failed);
    expect((await wuService.getById(wu.id))!.status).toBe('active');

    await loop.recordResult({ workUnit: wu }, failed);
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('blocked');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata!);
    expect(meta.consecutiveStuck).toBe(3);

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('连续 3 步无进展');
    expect(messages[0].content).toContain('provider quota exhausted');
  });

  it('recordResult: 中途 progress 清零 consecutiveStuck，之后 failed 重新计数', async () => {
    const wu = await createActiveWorkUnit();
    const loop = agentLoop as unknown as RecordResultCapable;
    const failed = { action: 'failed', summary: 'CLI 执行失败: boom' };

    await loop.recordResult({ workUnit: wu }, failed);
    await loop.recordResult({ workUnit: wu }, failed);
    await loop.recordResult({ workUnit: wu }, { action: 'progress', summary: '恢复推进' });
    let meta: WorkUnitMetadata = JSON.parse((await wuService.getById(wu.id))!.metadata!);
    expect(meta.consecutiveStuck).toBe(0);

    await loop.recordResult({ workUnit: wu }, failed);
    meta = JSON.parse((await wuService.getById(wu.id))!.metadata!);
    expect(meta.consecutiveStuck).toBe(1);
    expect((await wuService.getById(wu.id))!.status).toBe('active');
  });

  it('recordResult: progress/complete 空 summary 不发频道消息', async () => {
    const wu = await createActiveWorkUnit();
    const loop = agentLoop as unknown as RecordResultCapable;

    await loop.recordResult({ workUnit: wu }, { action: 'progress', summary: '' });
    await loop.recordResult({ workUnit: wu }, { action: 'progress', summary: '   ' });
    let messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.filter(m => m.authorType === 'agent')).toHaveLength(0);

    // 非空 summary 正常发帖
    await loop.recordResult({ workUnit: wu }, { action: 'progress', summary: '有实质进展' });
    messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.filter(m => m.authorType === 'agent')).toHaveLength(1);
  });
});
