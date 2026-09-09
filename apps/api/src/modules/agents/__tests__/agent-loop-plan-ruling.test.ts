// #467：裁决轮——plan 一脉会话内的一次性人闸（票体「形态更新 2026-09-09」定稿）
// parser：NEED_INPUT 紧随的 RULING: JSON 行 → StepResult.rulings（问题清单 + 每题建议结论 + 默认值）
// loop：need_input + rulings → metadata.planRulings 落档 + waitingReason='plan-ruling'
//   + 里程碑消息 meta.cardType='plan_ruling'（前端裁决接力卡数据源）
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 knowledge-service mock（同 agent-loop-need-input）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { executeLightweight: vi.fn() },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop, parseAgentOutput } from '../loop/agent-loop';

const mockRole = {
  id: 'role-ruling',
  name: 'ruling-agent',
  description: 'ruling test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface RecordResultCapable {
  recordResult(target: unknown, result: unknown): Promise<void>;
}

describe('#467 parser：NEED_INPUT 携 RULING 行', () => {
  it('RULING 行逐条解析（question/suggestion/default）', () => {
    const result = parseAgentOutput([
      '调研完毕，三个问题请人裁决。',
      'ACTION: NEED_INPUT:裁决轮——3 个待决问题请一次性裁决',
      'RULING: {"question":"存储选型？","suggestion":"SQLite","default":"单机默认 SQLite"}',
      'RULING: {"question":"部署形态？","suggestion":"单机"}',
    ].join('\n'));
    expect(result.action).toBe('need_input');
    expect(result.rulings).toEqual([
      { question: '存储选型？', suggestion: 'SQLite', default: '单机默认 SQLite' },
      { question: '部署形态？', suggestion: '单机' },
    ]);
  });

  it('RULING 与 OPTIONS 行可共存（#279 选项解析不受影响）', () => {
    const result = parseAgentOutput([
      'ACTION: NEED_INPUT:裁决轮',
      'OPTIONS: [{"label":"全对","value":"ok"}]',
      'RULING: {"question":"q1","suggestion":"s1"}',
    ].join('\n'));
    expect(result.options).toEqual([{ label: '全对', value: 'ok' }]);
    expect(result.rulings).toEqual([{ question: 'q1', suggestion: 's1' }]);
  });

  it('坏行防御：JSON 损坏跳过、缺 question/suggestion 丢弃、首个非 RULING 行出区', () => {
    const result = parseAgentOutput([
      'ACTION: NEED_INPUT:裁决轮',
      'RULING: {bad json',
      'RULING: {"question":"只有问题"}',
      'RULING: {"suggestion":"只有建议"}',
      'RULING: {"question":"q","suggestion":"s"}',
      '普通文本行',
      'RULING: {"question":"出区后不计","suggestion":"x"}',
    ].join('\n'));
    expect(result.rulings).toEqual([{ question: 'q', suggestion: 's' }]);
  });

  it('封顶 12 条（MAP_OPENING_FOG_MAX 口径）', () => {
    const lines = ['ACTION: NEED_INPUT:裁决轮'];
    for (let i = 1; i <= 15; i++) lines.push(`RULING: {"question":"q${i}","suggestion":"s${i}"}`);
    const result = parseAgentOutput(lines.join('\n'));
    expect(result.rulings).toHaveLength(12);
  });

  it('回归：无 RULING 行的 NEED_INPUT rulings 为 undefined', () => {
    const result = parseAgentOutput('ACTION: NEED_INPUT:用 OAuth 还是账号密码？');
    expect(result.action).toBe('need_input');
    expect(result.rulings).toBeUndefined();
  });
});

describe('#467 loop：裁决轮挂起与接力卡', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-ruling-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-ruling-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#ruling-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function setupPlanWu() {
    return wuService.create({
      scope: '规划需求 PMO-1: 测试', channelId, type: 'plan',
      status: 'active', assigneeId: 'instance-1',
      metadata: { pmoId: 'proj-1' },
    });
  }

  it('need_input + rulings → planRulings/waitingReason 落档 + 里程碑带 plan_ruling 卡', async () => {
    const wu = await setupPlanWu();
    const rulings = [
      { question: '存储选型？', suggestion: 'SQLite', default: 'SQLite' },
      { question: '部署形态？', suggestion: '单机' },
    ];

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '裁决轮——2 个待决问题请一次性裁决', rulings },
    );

    const parked = (await wuService.getById(wu.id))!;
    expect(parked.status).toBe('blocked');
    const meta: WorkUnitMetadata = JSON.parse(parked.metadata!);
    expect(meta.waitingForInput).toBe(true);
    expect(meta.waitingReason).toBe('plan-ruling');
    expect(meta.planRulings).toEqual(rulings);

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const question = messages.find(m => m.authorType === 'agent' && m.content.includes('需要输入'));
    expect(question).toBeDefined();
    const msgMeta = JSON.parse(question!.meta as string);
    expect(msgMeta.cardType).toBe('plan_ruling');
  });

  it('回归：无 rulings 的 need_input 不落 planRulings/waitingReason、不带卡', async () => {
    const wu = await setupPlanWu();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '澄清：目标是内部工具还是对外产品？' },
    );

    const meta: WorkUnitMetadata = JSON.parse((await wuService.getById(wu.id))!.metadata!);
    expect(meta.waitingForInput).toBe(true);
    expect(meta.planRulings).toBeUndefined();
    expect(meta.waitingReason).toBeUndefined();

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const question = messages.find(m => m.authorType === 'agent' && m.content.includes('需要输入'));
    expect(JSON.parse(question!.meta as string).cardType).toBeUndefined();
  });
});
