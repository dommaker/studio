// #96: CLI 上下文溢出纯反应式策略 —— 溢出错误 → 会话滚动摘要落盘 → 新会话带摘要
// 注入重试一次 → 再败 NEED_INPUT；并收口 #95 降级路径超限（续用降级也遵守 MAX）。
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 knowledge-service mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';
import type { AgentTask } from '@dommaker/studio-agent';

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
  id: 'role-overflow',
  name: 'overflow-agent',
  description: 'context overflow test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface AgentStepCapable {
  agentStep(target: unknown): Promise<{ action: string; summary: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SUCCESS_RESULT = {
  success: true, outputText: 'ACTION: PROGRESS:继续',
  logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
};

const OVERFLOW_FAILURE = {
  success: false, error: 'Prompt is too long',
  logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
};

const SESSION_NOT_FOUND_FAILURE = {
  success: false, error: 'No conversation found with session ID sess-lost',
  logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
};

describe('#96: CLI 上下文溢出纯反应式策略', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-overflow-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-overflow-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#overflow-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // 不 start()：agentStep 不依赖运行中的 loop 实例
    agentLoop = new AgentLoop(mockRole, fileStore);
    // 默认成功（各测试用 mockImplementationOnce 覆盖首调形态）
    mockExecuteLightweight.mockResolvedValue({ ...SUCCESS_RESULT });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function setupWorkUnit(metadata?: WorkUnitMetadata) {
    return wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-1',
      ...(metadata ? { metadata } : {}),
    });
  }

  function taskAt(index: number): AgentTask {
    return mockExecuteLightweight.mock.calls.at(index)![0] as AgentTask;
  }

  it('续用会话溢出 → 新会话带摘要重试成功：sessionCount+1、sessionSummary 落盘、重试 prompt 注入摘要', async () => {
    const wu = await setupWorkUnit({
      sessionId: 'sess-overflow', sessionCount: 1, stepCount: 2,
      progressLog: [{ step: 1, action: 'progress', summary: '完成数据层', at: '2026-08-12T10:00:00Z' }],
    });
    // 首次（续用形态）报溢出；重试走默认成功
    let firstParams: AgentTask['parameters'] | undefined;
    mockExecuteLightweight.mockImplementationOnce(async (task: AgentTask) => {
      firstParams = { ...task.parameters };
      return { ...OVERFLOW_FAILURE };
    });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(2);
    // 首次：续用形态；重试：新建形态（claude 传新 UUID、不带 sessionResume）
    expect(firstParams?.sessionId).toBe('sess-overflow');
    expect(firstParams?.sessionResume).toBe(true);
    const retryParams = taskAt(1).parameters!;
    expect(retryParams.sessionId).toMatch(UUID_RE);
    expect(retryParams.sessionId).not.toBe('sess-overflow');
    expect(retryParams.sessionResume).toBeUndefined();
    // 摘要落盘 + 会话簿记：新号、sessionCount+1、lastSessionResumed=false
    expect(step.action).toBe('progress');
    expect(step.metadataUpdates?.sessionId).toBe(retryParams.sessionId);
    expect(step.metadataUpdates?.sessionCount).toBe(2);
    expect(step.metadataUpdates?.lastSessionResumed).toBe(false);
    expect(typeof step.metadataUpdates?.sessionSummary).toBe('string');
    expect(step.metadataUpdates?.sessionSummary).toContain('实现登录功能');
    expect(step.metadataUpdates?.sessionSummary).toContain('完成数据层');
    // 重试 prompt 注入摘要段
    expect(taskAt(1).prompt).toContain('## 会话摘要（上下文溢出）');
    expect(taskAt(1).prompt).toContain('完成数据层');
  });

  it('新建会话（首步后）溢出 → 同样落盘摘要并重试一次', async () => {
    const wu = await setupWorkUnit({
      sessionCount: 1, stepCount: 1,
      progressLog: [{ step: 1, action: 'progress', summary: '完成数据层', at: '2026-08-12T10:00:00Z' }],
    });
    mockExecuteLightweight.mockImplementationOnce(async () => ({ ...OVERFLOW_FAILURE }));

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(2);
    expect(step.action).toBe('progress');
    expect(step.metadataUpdates?.sessionCount).toBe(2);
    expect(typeof step.metadataUpdates?.sessionSummary).toBe('string');
    expect(taskAt(1).prompt).toContain('## 会话摘要（上下文溢出）');
  });

  it('溢出重试仍失败 → NEED_INPUT（合流既有路径）：sessionSummary 保留落盘、sessionId 重置、sessionCount 计入', async () => {
    const wu = await setupWorkUnit({ sessionId: 'sess-overflow', sessionCount: 1 });
    mockExecuteLightweight.mockResolvedValue({ ...OVERFLOW_FAILURE });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(2);
    expect(step.action).toBe('need_input');
    expect(step.summary).toContain('上下文溢出');
    // #90: 溢出重试再败转 need_input 也落 failure outcome
    expect(knowledgeService.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorType: 'execution_failed',
    }));
    // 摘要保留（落盘供人工参考），会话簿记：sessionId 重置、sessionCount 计入
    expect(typeof step.metadataUpdates?.sessionSummary).toBe('string');
    expect(step.metadataUpdates).not.toHaveProperty('sessionId');
    expect(step.metadataUpdates!.sessionCount).toBe(2);
    expect(step.metadataUpdates).not.toHaveProperty('lastSessionResumed');
  });

  it('溢出且会话配额已满（sessionCount>=MAX）→ 摘要落盘 + 直接 NEED_INPUT，不再起新会话', async () => {
    const wu = await setupWorkUnit({ sessionId: 'sess-overflow', sessionCount: 5 });
    mockExecuteLightweight.mockResolvedValue({ ...OVERFLOW_FAILURE });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    // 只执行一次（无重试）
    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
    expect(step.action).toBe('need_input');
    expect(step.summary).toContain('会话重建已达上限');
    expect(typeof step.metadataUpdates?.sessionSummary).toBe('string');
    expect(step.metadataUpdates).not.toHaveProperty('sessionCount');
  });

  it('非溢出错误（CLI boom）→ 不触发溢出重试，action=failed', async () => {
    const wu = await setupWorkUnit({ sessionId: 'sess-overflow', sessionCount: 1 });
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'CLI boom', logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
    expect(step.action).toBe('failed');
    expect(step.metadataUpdates).not.toHaveProperty('sessionSummary');
  });

  it('#95 收口：续用降级（会话不存在）且会话配额已满 → 直接 NEED_INPUT，不再绕过 MAX 起新会话', async () => {
    const wu = await setupWorkUnit({ sessionId: 'sess-lost', sessionCount: 5 });
    mockExecuteLightweight.mockResolvedValue({ ...SESSION_NOT_FOUND_FAILURE });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
    expect(step.action).toBe('need_input');
    expect(step.summary).toContain('会话重建已达上限');
  });

  it('#95 回归：续用降级（会话不存在）且配额未满 → 仍换新号重试一次（行为不变）', async () => {
    const wu = await setupWorkUnit({ sessionId: 'sess-lost', sessionCount: 1 });
    mockExecuteLightweight.mockImplementationOnce(async () => ({ ...SESSION_NOT_FOUND_FAILURE }));

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(2);
    expect(step.action).toBe('progress');
    expect(step.metadataUpdates?.sessionCount).toBe(2);
    expect(step.metadataUpdates?.sessionId).toMatch(UUID_RE);
    expect(step.metadataUpdates?.lastSessionResumed).toBe(false);
  });
});
