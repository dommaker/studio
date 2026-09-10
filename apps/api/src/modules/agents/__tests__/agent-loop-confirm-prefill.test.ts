// #463：decision/spec 确认表单的结构化预填数据源——agent COMPLETE 输出在确认前
// 已解析落档（照 analysisFog/analysisTasks 先例）：
//   decision → `## 结论摘要` 段（prompt 契约已有）解析落 metadata.decisionSuggestion；
//   spec     → TASK: 物化行（spec-materialization 同一解析器）落 metadata.specTasks。
// 形态照 agent-loop-analysis-fog.test.ts（真实 FileStore + agentStep/recordResult 两步驱动）。
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
  id: 'role-confirm',
  name: 'confirm-agent',
  description: 'confirm prefill test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface AgentStepCapable {
  agentStep(target: unknown): Promise<{ action: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
  recordResult(target: unknown, result: unknown): Promise<void>;
}

describe('#463 decision/spec COMPLETE：确认表单结构化预填落档', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-confirm-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-confirm-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#confirm-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function setupWu(type: 'decision' | 'spec') {
    return wuService.create({
      scope: type === 'decision' ? '待决问题 PMO-1: 存储选型？' : '成文 PMO-1: 测试',
      channelId, type, status: 'active', assigneeId: 'instance-1',
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

  it('decision：输出 `## 结论摘要` 段 → decisionSuggestion 落档（段落到下一标题为止）', async () => {
    const wu = await setupWu('decision');
    mockComplete([
      '分析过程略。',
      '## 结论摘要',
      '选型用 SQLite，理由是单机部署零依赖。',
      '## 其他',
      'ACTION: COMPLETE: 讨论完成',
    ].join('\n'));

    const stepResult = await runCompleteStep(wu.id);
    expect(stepResult.action).toBe('complete');

    const meta = await readMeta(wu.id);
    expect(meta.decisionSuggestion).toBe('选型用 SQLite，理由是单机部署零依赖。');
  });

  it('decision：无结论摘要段 → 不落 decisionSuggestion', async () => {
    const wu = await setupWu('decision');
    mockComplete('讨论了一阵。\nACTION: COMPLETE: done');

    await runCompleteStep(wu.id);

    const meta = await readMeta(wu.id);
    expect(meta.decisionSuggestion).toBeUndefined();
  });

  it('spec：输出 TASK 物化行 → specTasks 结构化落档（含 AC 段）', async () => {
    const wu = await setupWu('spec');
    mockComplete([
      '成文内容略。',
      'TASK: 实现存储层 | AC: 单测覆盖 | AC: 通过 typecheck',
      'TASK: 接通派工 | LEG: dommaker/studio',
      'ACTION: COMPLETE: 成文完成',
    ].join('\n'));

    await runCompleteStep(wu.id);

    const meta = await readMeta(wu.id);
    expect(meta.specTasks).toEqual([
      { title: '实现存储层', ac: ['单测覆盖', '通过 typecheck'], blockedBy: [] },
      { title: '接通派工', ac: [], blockedBy: [], leg: 'dommaker/studio' },
    ]);
  });

  it('spec：无 TASK 行 → 不落 specTasks', async () => {
    const wu = await setupWu('spec');
    mockComplete('成文内容。\nACTION: COMPLETE: done');

    await runCompleteStep(wu.id);

    const meta = await readMeta(wu.id);
    expect(meta.specTasks).toBeUndefined();
  });
});
