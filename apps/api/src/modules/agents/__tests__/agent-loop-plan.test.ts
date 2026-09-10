// #471：plan WU（派生链收敛 = 一脉会话）的 agent-loop 行为：
//   1) plan COMPLETE 解析 TASK:/FOG:/DESTINATION: 行落 metadata（analysisTasks/
//      analysisFog/analysisDestination——沿用 analysis 字段名，解析契约单一来源不变，
//      人工确认弹窗预填与 map-opening/analysis-handoff 消费不变）；
//   2) plan 单独步数额度 PLAN_STEP_LIMIT=60（> implement 15 / review 30，Triage 定稿 1）：
//      到线 → need_input 挂 blocked 转人（waitingReason='plan-step-limit'），不静默截断、
//      不走 STEP_LIMIT=15 的强制收口 in_review；人回复即续期（waiting-input 侧 allowance += 60）。
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；形态照 agent-loop-analysis-fog.test.ts。
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

const mockRole = {
  id: 'role-plan',
  name: 'plan-agent',
  description: 'plan test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface AgentStepCapable {
  agentStep(target: unknown): Promise<{ action: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
  recordResult(target: unknown, result: unknown): Promise<void>;
}

describe('plan WU：COMPLETE 解析 + 步数额度（#471）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-plan-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-plan-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#plan-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function setupPlanWu(metadata?: Partial<WorkUnitMetadata>) {
    return wuService.create({
      scope: '规划需求 PMO-1: 测试 +requirement-clarify +to-tickets', channelId, type: 'plan',
      status: 'active', assigneeId: 'instance-1',
      ...(metadata ? { metadata } : {}),
    });
  }

  function mockComplete(outputText: string) {
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText, logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
  }

  async function runCompleteStep(wuId: string) {
    const wu = (await wuService.getById(wuId))!;
    const loop = agentLoop as unknown as AgentStepCapable;
    const stepResult = await loop.agentStep({ workUnit: wu });
    await loop.recordResult({ workUnit: wu }, stepResult);
    return stepResult;
  }

  async function readMeta(wuId: string): Promise<WorkUnitMetadata> {
    return JSON.parse((await wuService.getById(wuId))!.metadata!) as WorkUnitMetadata;
  }

  it('plan COMPLETE：TASK/FOG/DESTINATION 行落 metadata（沿用 analysis 字段名）', async () => {
    const wu = await setupPlanWu();
    mockComplete([
      '规划结论：两件待决已裁决。',
      'DESTINATION: 三仓特性联动上线',
      'FOG: 存储选型用哪个？',
      'TASK: 实现存储层',
      'TASK: 接热线',
      'ACTION: COMPLETE: 规划完成',
    ].join('\n'));

    const stepResult = await runCompleteStep(wu.id);
    expect(stepResult.action).toBe('complete');

    const meta = await readMeta(wu.id);
    expect(meta.analysisDestination).toBe('三仓特性联动上线');
    expect(meta.analysisFog).toEqual(['存储选型用哪个？']);
    expect(meta.analysisTasks).toEqual(['实现存储层', '接热线']);
  });

  it('plan COMPLETE 无 FOG（非探路型）→ 只落 analysisTasks', async () => {
    const wu = await setupPlanWu();
    mockComplete('结论。\nTASK: 直接干活\nACTION: COMPLETE: done');

    await runCompleteStep(wu.id);

    const meta = await readMeta(wu.id);
    expect(meta.analysisFog).toBeUndefined();
    expect(meta.analysisDestination).toBeUndefined();
    expect(meta.analysisTasks).toEqual(['直接干活']);
  });

  it('plan 步数到 60 额度 → need_input 挂起转人（waitingReason=plan-step-limit，不起会话）', async () => {
    const wu = await setupPlanWu({ stepCount: 60 });
    const loop = agentLoop as unknown as AgentStepCapable;

    const stepResult = await loop.agentStep({ workUnit: wu });

    expect(stepResult.action).toBe('need_input');
    expect(stepResult.metadataUpdates?.waitingReason).toBe('plan-step-limit');
    expect(mockExecuteLightweight).not.toHaveBeenCalled();

    await loop.recordResult({ workUnit: wu }, stepResult);
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('blocked');
  });

  it('plan 续期后（planStepAllowance=120，stepCount=61）→ 正常起会话，不再挂起', async () => {
    const wu = await setupPlanWu({ stepCount: 61, planStepAllowance: 120 });
    mockComplete('继续干活\nACTION: PROGRESS: 推进中');
    const loop = agentLoop as unknown as AgentStepCapable;

    const stepResult = await loop.agentStep({ workUnit: wu });

    expect(stepResult.action).toBe('progress');
    expect(mockExecuteLightweight).toHaveBeenCalled();
  });

  it('plan stepCount 超 15 未超 60 → recordResult 不强制收口 in_review（STEP_LIMIT 不适用于 plan）', async () => {
    const wu = await setupPlanWu({ stepCount: 20 });
    const loop = agentLoop as unknown as AgentStepCapable;

    await loop.recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('active');
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('步骤数超限'))).toBe(false);
  });

  it('plan 续期授权额度内（allowance=120，stepCount=100）→ recordResult 同样不强制收口', async () => {
    const wu = await setupPlanWu({ stepCount: 100, planStepAllowance: 120 });
    const loop = agentLoop as unknown as AgentStepCapable;

    await loop.recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('active');
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('步骤数超限'))).toBe(false);
  });

  it('task WU stepCount 超 15 → 强制 in_review（原行为不回归）', async () => {
    const wu = await wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-dev',
      metadata: { stepCount: 15 },
    });
    const loop = agentLoop as unknown as AgentStepCapable;

    await loop.recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('in_review');
  });
});
