// #106 M7 对齐：analysis WU COMPLETE 时 agentStep 解析输出中的 FOG:/DESTINATION: 行落
// metadata（analysisFog/analysisDestination）——人工确认弹窗据此预填待决问题清单
// （审清单，人改后随 l3.summary 回传，map-opening 消费契约不变）。
// 解析器复用 pmo/map-opening 同一来源。真实 FileStore（tmpdir）+ 真实 WorkUnitService；
// 形态照 agent-loop-need-input.test.ts（agentStep + recordResult 两步驱动）
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
  id: 'role-fog',
  name: 'fog-agent',
  description: 'analysis fog test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface AgentStepCapable {
  agentStep(target: unknown): Promise<{ action: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
  recordResult(target: unknown, result: unknown): Promise<void>;
}

describe('analysis COMPLETE：FOG:/DESTINATION: 行落 metadata', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-fog-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-fog-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#fog-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function setupAnalysisWu() {
    return wuService.create({
      scope: '分析需求 PMO-1: 测试', channelId, type: 'analysis',
      status: 'active', assigneeId: 'instance-1',
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

  it('FOG + DESTINATION 行 → analysisFog/analysisDestination 落档；TASK 行共存照解析', async () => {
    const wu = await setupAnalysisWu();
    mockComplete([
      '分析结论：需要人工拍板两件事。',
      'DESTINATION: 三仓特性联动上线',
      'FOG: 存储选型用哪个？',
      'FOG：部署形态先单机还是分布式？',
      'TASK: 实现存储层',
      'ACTION: COMPLETE: 分析完成',
    ].join('\n'));

    const stepResult = await runCompleteStep(wu.id);
    expect(stepResult.action).toBe('complete');

    const meta = await readMeta(wu.id);
    expect(meta.analysisDestination).toBe('三仓特性联动上线');
    expect(meta.analysisFog).toEqual(['存储选型用哪个？', '部署形态先单机还是分布式？']);
    expect(meta.analysisTasks).toEqual(['实现存储层']);
  });

  it('无 FOG 行（非探路型）→ 不写 analysisFog/analysisDestination', async () => {
    const wu = await setupAnalysisWu();
    mockComplete('结论。\nTASK: 直接干活\nACTION: COMPLETE: done');

    await runCompleteStep(wu.id);

    const meta = await readMeta(wu.id);
    expect(meta.analysisFog).toBeUndefined();
    expect(meta.analysisDestination).toBeUndefined();
    expect(meta.analysisTasks).toEqual(['直接干活']);
  });

  it('有 FOG 无 DESTINATION → 只落 analysisFog（目的地缺省回退项目 title，归 map-opening）', async () => {
    const wu = await setupAnalysisWu();
    mockComplete('FOG: 队列方案？\nACTION: COMPLETE: done');

    await runCompleteStep(wu.id);

    const meta = await readMeta(wu.id);
    expect(meta.analysisFog).toEqual(['队列方案？']);
    expect(meta.analysisDestination).toBeUndefined();
  });

  it('只有 DESTINATION 无 FOG → 两字段均不落档（无雾 = 非探路型，目的地无人消费）', async () => {
    const wu = await setupAnalysisWu();
    mockComplete('DESTINATION: 单机先跑通\nTASK: 干活\nACTION: COMPLETE: done');

    await runCompleteStep(wu.id);

    const meta = await readMeta(wu.id);
    expect(meta.analysisFog).toBeUndefined();
    expect(meta.analysisDestination).toBeUndefined();
    expect(meta.analysisTasks).toEqual(['干活']);
  });
});
