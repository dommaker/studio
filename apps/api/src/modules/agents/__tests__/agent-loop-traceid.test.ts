// P0 修复 6: traceId 贯穿 — agent-loop 段
// - agentStep 读 wu metadata.traceId → 注入执行参数（extraEnv.STUDIO_TRACE_ID）
// - agentStep 失败日志行带 traceId 字段
// - recordResult 每步留 trace 锚点日志（仅 WU 带 traceId 时）
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 knowledge-service mock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, logger } from '@dommaker/studio-shared';
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

const mockRole = {
  id: 'role-trace',
  name: 'trace-agent',
  description: 'traceId test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface LoopInternals {
  recordResult(target: unknown, result: unknown): Promise<void>;
  agentStep(target: unknown): Promise<{ action: string; summary: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
}

describe('P0 修复 6: agent-loop traceId', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-trace-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-trace-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#trace-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function createWorkUnit(metadata?: WorkUnitMetadata) {
    return wuService.create({
      scope: '实现某个功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-1',
      metadata,
    });
  }

  it('agentStep: metadata.traceId 注入 extraEnv.STUDIO_TRACE_ID', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:推进中',
      worktree: '/tmp/wt', outputFiles: [], logFile: '/tmp/log', sessionCount: 1,
    });

    const wu = await createWorkUnit({ traceId: 'trace-xyz-789' });
    await (agentLoop as unknown as LoopInternals).agentStep({ workUnit: wu });

    const task = mockExecuteLightweight.mock.calls[0][0];
    expect(task.parameters.extraEnv.STUDIO_TRACE_ID).toBe('trace-xyz-789');
    expect(task.parameters.extraEnv.STUDIO_WORKUNIT_ID).toBe(wu.id);
  });

  it('agentStep: 无 traceId 的 WU → STUDIO_TRACE_ID 为空串', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:推进中',
      worktree: '/tmp/wt', outputFiles: [], logFile: '/tmp/log', sessionCount: 1,
    });

    const wu = await createWorkUnit();
    await (agentLoop as unknown as LoopInternals).agentStep({ workUnit: wu });

    const task = mockExecuteLightweight.mock.calls[0][0];
    expect(task.parameters.extraEnv.STUDIO_TRACE_ID).toBe('');
  });

  it('agentStep: 失败日志行带 traceId 字段', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'CLI exited with code 1: boom',
      worktree: '/tmp/wt', outputFiles: [], logFile: '/tmp/log', sessionCount: 1,
    });

    const wu = await createWorkUnit({ traceId: 'trace-fail-1' });
    const result = await (agentLoop as unknown as LoopInternals).agentStep({ workUnit: wu });

    expect(result.action).toBe('failed');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('agentStep execution failed'),
      expect.objectContaining({ traceId: 'trace-fail-1' }),
    );
  });

  it('recordResult: 带 traceId 的 WU 每步留锚点日志；不带则不留', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const loop = agentLoop as unknown as LoopInternals;

    const withTrace = await createWorkUnit({ traceId: 'trace-anchor-1' });
    await loop.recordResult({ workUnit: withTrace }, { action: 'progress', summary: '推进一步' });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Step recorded'),
      expect.objectContaining({ traceId: 'trace-anchor-1', action: 'progress', stepCount: 1 }),
    );

    infoSpy.mockClear();
    const noTrace = await createWorkUnit();
    await loop.recordResult({ workUnit: noTrace }, { action: 'progress', summary: '推进一步' });

    const anchorCalls = infoSpy.mock.calls.filter(c => String(c[0]).includes('Step recorded'));
    expect(anchorCalls).toHaveLength(0);
  });
});
