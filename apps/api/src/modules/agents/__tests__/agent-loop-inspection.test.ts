// #163（T8-E2）：巡检单（analysis + metadata.inspection）COMPLETE 时 agentStep 解析
// OPPORTUNITY: 协议行落 metadata.opportunities（初始全 pending，id=opp-N）——
// 冷却闸与 web 采纳/忽略消费。形态照 agent-loop-analysis-fog.test.ts（agentStep + recordResult 两步驱动）
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
  id: 'role-insp',
  name: 'insp-agent',
  description: 'inspection test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface AgentStepCapable {
  agentStep(target: unknown): Promise<{ action: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
  recordResult(target: unknown, result: unknown): Promise<void>;
}

describe('inspection COMPLETE：OPPORTUNITY: 行落 metadata.opportunities', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let agentLoop: AgentLoop;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-insp-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function setupWu(inspection: boolean) {
    return wuService.create({
      scope: '全仓巡检', type: 'analysis',
      status: 'active', assigneeId: 'instance-1',
      ...(inspection ? { metadata: { inspection: true, tokenBudget: 500000 } } : {}),
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

  it('OPPORTUNITY 行 → opportunities 落档（初始 pending + opp-N id）', async () => {
    const wu = await setupWu(true);
    mockComplete([
      '巡检报告已落盘。',
      'OPPORTUNITY: {"problem":"登录接口缺少限流","suggestion":"加 rate-limit 中间件","estimate":"半天"}',
      'OPPORTUNITY: {"problem":"README 与启动命令不一致","suggestion":"改快速开始段"}',
      'ACTION: COMPLETE: 巡检完成',
    ].join('\n'));

    const stepResult = await runCompleteStep(wu.id);
    expect(stepResult.action).toBe('complete');

    const meta = await readMeta(wu.id);
    expect(meta.opportunities).toEqual([
      { id: 'opp-1', problem: '登录接口缺少限流', suggestion: '加 rate-limit 中间件', estimate: '半天', status: 'pending' },
      { id: 'opp-2', problem: 'README 与启动命令不一致', suggestion: '改快速开始段', status: 'pending' },
    ]);
  });

  it('无 OPPORTUNITY 行 → 不写 opportunities（不阻断完成）', async () => {
    const wu = await setupWu(true);
    mockComplete('本轮未发现机会。\nACTION: COMPLETE: done');

    await runCompleteStep(wu.id);

    expect((await readMeta(wu.id)).opportunities).toBeUndefined();
  });

  it('非巡检 analysis（无 inspection 标记）→ OPPORTUNITY 行不解析', async () => {
    const wu = await setupWu(false);
    mockComplete('OPPORTUNITY: {"problem":"p","suggestion":"s"}\nACTION: COMPLETE: done');

    await runCompleteStep(wu.id);

    expect((await readMeta(wu.id)).opportunities).toBeUndefined();
  });
});
