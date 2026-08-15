// P0 修复（W-3 接线）：CLI 执行失败（runner 返回 success:false）的显式失败分支
// - agentStep: success:false → action='failed'，errorType/errorDetail 记入 metadataUpdates
// - recordResult: failed 记 consecutiveStuck、发「执行失败（第 N 次）」系统消息（#175/#55 决议）；
//   连续 3 次 → blocked 里程碑且频道说明失败原因（第 3 次不额外发失败消息）
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
  let eventsFile: string;
  const prevEventsEnv = process.env.STUDIO_EVENTS_FILE;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-w3-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-w3-${Date.now()}`;
    // #172: 事件文件按用例隔离（writeStudioEvent 系落盘经 STUDIO_EVENTS_FILE 覆盖）
    eventsFile = path.join(testDir, 'studio-events.jsonl');
    process.env.STUDIO_EVENTS_FILE = eventsFile;
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
    if (prevEventsEnv === undefined) delete process.env.STUDIO_EVENTS_FILE;
    else process.env.STUDIO_EVENTS_FILE = prevEventsEnv;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** fire-and-forget 事件写盘轮询（≤1s）；type 缺省返回全部已落盘事件 */
  async function readStudioEventsFile(): Promise<Array<Record<string, unknown>>> {
    if (!fs.existsSync(eventsFile)) return [];
    return fs.readFileSync(eventsFile, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  async function waitForEvent(type: string): Promise<Record<string, unknown> | null> {
    for (let i = 0; i < 50; i++) {
      const hit = (await readStudioEventsFile()).find(e => e.type === type);
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 20));
    }
    return null;
  }

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

  it('recordResult: failed 记 consecutiveStuck、保持 active、发一条步失败系统消息（#175）', async () => {
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
    const agentMsgs = messages.filter(m => m.authorType === 'agent');
    expect(agentMsgs).toHaveLength(1);
    expect(agentMsgs[0].content).toBe('『w3-agent』执行失败（第 1 次）：CLI 执行失败: boom');
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
    // #175：第 1/2 次各发一条步失败消息，第 3 次走 blocked 里程碑（不额外发失败消息）
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toContain('执行失败（第 1 次）');
    expect(messages[1].content).toContain('执行失败（第 2 次）');
    expect(messages[2].content).toContain('连续 3 步无进展');
    expect(messages[2].content).toContain('provider quota exhausted');
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

  // ─── #172（#60 决策 Q1）：失败在事件流中可查可统计 ───

  it('#172: agentStep success:false → 失败步 execution_step 事件落盘（status=failed + 错误字段）', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'CLI exited with code 1: boom',
      worktree: '/tmp/wt', outputFiles: [], logFile: '/tmp/log', sessionCount: 1,
    });

    const wu = await createActiveWorkUnit();
    await (agentLoop as unknown as RecordResultCapable).agentStep({ workUnit: wu });

    const ev = await waitForEvent('workunit:execution_step');
    expect(ev).not.toBeNull();
    const payload = JSON.parse(ev!.payload as string);
    expect(payload.workUnitId).toBe(wu.id);
    expect(payload.status).toBe('failed');
    expect(payload.errorType).toBe('execution_failed');
    expect(payload.errorDetail).toContain('boom');
  });

  it('#172: 连续 3 次 failed → blocked 时落 workunit:failed（level=warning + 决策 payload 字段）', async () => {
    const wu = await createActiveWorkUnit();
    const loop = agentLoop as unknown as RecordResultCapable;
    const failed = {
      action: 'failed',
      summary: 'CLI 执行失败: provider quota exhausted',
      metadataUpdates: { errorType: 'execution_failed', errorDetail: 'provider quota exhausted' },
    };

    await loop.recordResult({ workUnit: wu }, failed);
    await loop.recordResult({ workUnit: wu }, failed);
    await loop.recordResult({ workUnit: wu }, failed);
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');

    const ev = await waitForEvent('workunit:failed');
    expect(ev).not.toBeNull();
    expect(ev!.level).toBe('warning');
    const payload = JSON.parse(ev!.payload as string);
    expect(payload.workUnitId).toBe(wu.id);
    expect(payload.failureType).toBe('execution_failed');
    expect(payload.blockReason).toContain('连续 3 步无进展');
    expect(payload.consecutiveStuck).toBe(3);
    expect(payload.attempts).toBe(3);
    expect(typeof payload.totalDurationMs).toBe('number');
  });

  it('#172: need_input 挂起转 blocked 不产 workunit:failed（挂起 ≠ 终态失败）', async () => {
    const wu = await createActiveWorkUnit();
    const loop = agentLoop as unknown as RecordResultCapable;

    await loop.recordResult({ workUnit: wu }, { action: 'need_input', summary: '需要人类确认方案' });
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');

    // 等一拍确认无 workunit:failed 落盘
    await new Promise(r => setTimeout(r, 100));
    const events = await readStudioEventsFile();
    expect(events.filter(e => e.type === 'workunit:failed')).toHaveLength(0);
  });
});
