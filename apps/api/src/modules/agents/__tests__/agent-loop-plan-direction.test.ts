// #567：方向锁定——plan 一脉会话裁决轮的前置可选环节（互斥大方向先出一次方向卡）
// parser：NEED_INPUT 紧随的 DIRECTION: JSON 行 → StepResult.directions
//   （方向抉择点 + 候选方向清单；防御口径同 RULING，options 2..4 条、recommended 恰好一个）
// loop：need_input + directions → metadata.planDirections 落档 + waitingReason='plan-direction'
//   + 里程碑消息 meta.cardType='plan_direction'（前端方向接力卡数据源）
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 knowledge-service mock（同 agent-loop-plan-ruling）
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

import { AgentLoop } from '../loop/agent-loop';
import { parseAgentOutput } from '../loop/agent-loop-parsers';

const mockRole = {
  id: 'role-direction',
  name: 'direction-agent',
  description: 'direction test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface RecordResultCapable {
  recordResult(target: unknown, result: unknown): Promise<void>;
}

const DIRECTION_PAYLOAD = {
  question: '自研还是引入依赖？',
  options: [
    { name: '自研', summary: '自研调度内核', tradeoffs: '可控但慢', impact: '触及 scheduler 模块', recommended: true },
    { name: '引入依赖', summary: '引入 bullmq', tradeoffs: '快但多一个依赖', impact: '触及 api 与 daemon', recommended: false },
  ],
};

describe('#567 parser：NEED_INPUT 携 DIRECTION 行', () => {
  it('DIRECTION 行解析（question + options 五字段）', () => {
    const result = parseAgentOutput([
      '调研发现两个互斥大方向，请人先定方向。',
      'ACTION: NEED_INPUT:方向锁定——请选定本票方向',
      `DIRECTION: ${JSON.stringify(DIRECTION_PAYLOAD)}`,
    ].join('\n'));
    expect(result.action).toBe('need_input');
    expect(result.directions).toEqual(DIRECTION_PAYLOAD);
  });

  it('DIRECTION 与 OPTIONS/RULING 行共存（同区解析互不影响）', () => {
    const result = parseAgentOutput([
      'ACTION: NEED_INPUT:方向锁定',
      'OPTIONS: [{"label":"全对","value":"ok"}]',
      `DIRECTION: ${JSON.stringify(DIRECTION_PAYLOAD)}`,
      'RULING: {"question":"q1","suggestion":"s1"}',
    ].join('\n'));
    expect(result.options).toEqual([{ label: '全对', value: 'ok' }]);
    expect(result.rulings).toEqual([{ question: 'q1', suggestion: 's1' }]);
    expect(result.directions).toEqual(DIRECTION_PAYLOAD);
  });

  it('坏行防御：JSON 损坏跳过、question 缺失丢弃、首个其他行出区', () => {
    const result = parseAgentOutput([
      'ACTION: NEED_INPUT:方向锁定',
      'DIRECTION: {bad json',
      'DIRECTION: {"options":[{"name":"a","summary":"s","tradeoffs":"t","impact":"i","recommended":true},{"name":"b","summary":"s","tradeoffs":"t","impact":"i","recommended":false}]}',
      `DIRECTION: ${JSON.stringify(DIRECTION_PAYLOAD)}`,
      '普通文本行',
      `DIRECTION: ${JSON.stringify({ question: '出区后不计', options: DIRECTION_PAYLOAD.options })}`,
    ].join('\n'));
    expect(result.directions).toEqual(DIRECTION_PAYLOAD);
  });

  it('options 越界拒收：<2 条与 >4 条整条丢弃', () => {
    const one = parseAgentOutput([
      'ACTION: NEED_INPUT:方向锁定',
      `DIRECTION: ${JSON.stringify({ question: 'q', options: [DIRECTION_PAYLOAD.options[0]] })}`,
    ].join('\n'));
    expect(one.directions).toBeUndefined();

    const five = parseAgentOutput([
      'ACTION: NEED_INPUT:方向锁定',
      `DIRECTION: ${JSON.stringify({
        question: 'q',
        options: Array.from({ length: 5 }, (_, i) => ({
          name: `d${i}`, summary: 's', tradeoffs: 't', impact: 'i', recommended: i === 0,
        })),
      })}`,
    ].join('\n'));
    expect(five.directions).toBeUndefined();
  });

  it('recommended 非恰好一个 → 归一（全部置 false 后首条置 true）', () => {
    const none = parseAgentOutput([
      'ACTION: NEED_INPUT:方向锁定',
      `DIRECTION: ${JSON.stringify({
        question: 'q',
        options: [
          { name: 'a', summary: 's', tradeoffs: 't', impact: 'i', recommended: false },
          { name: 'b', summary: 's', tradeoffs: 't', impact: 'i', recommended: false },
        ],
      })}`,
    ].join('\n'));
    expect(none.directions!.options.map(o => o.recommended)).toEqual([true, false]);

    const two = parseAgentOutput([
      'ACTION: NEED_INPUT:方向锁定',
      `DIRECTION: ${JSON.stringify({
        question: 'q',
        options: [
          { name: 'a', summary: 's', tradeoffs: 't', impact: 'i', recommended: true },
          { name: 'b', summary: 's', tradeoffs: 't', impact: 'i', recommended: true },
        ],
      })}`,
    ].join('\n'));
    expect(two.directions!.options.map(o => o.recommended)).toEqual([true, false]);
  });

  it('字段截 500 字符（question/name/summary/tradeoffs/impact）', () => {
    const long = 'x'.repeat(600);
    const result = parseAgentOutput([
      'ACTION: NEED_INPUT:方向锁定',
      `DIRECTION: ${JSON.stringify({
        question: long,
        options: [
          { name: long, summary: long, tradeoffs: long, impact: long, recommended: true },
          { name: 'b', summary: 's', tradeoffs: 't', impact: 'i', recommended: false },
        ],
      })}`,
    ].join('\n'));
    expect(result.directions!.question).toHaveLength(500);
    expect(result.directions!.options[0].name).toHaveLength(500);
    expect(result.directions!.options[0].summary).toHaveLength(500);
    expect(result.directions!.options[0].tradeoffs).toHaveLength(500);
    expect(result.directions!.options[0].impact).toHaveLength(500);
  });

  it('回归：无 DIRECTION 行的 NEED_INPUT directions 为 undefined', () => {
    const result = parseAgentOutput('ACTION: NEED_INPUT:用 OAuth 还是账号密码？');
    expect(result.action).toBe('need_input');
    expect(result.directions).toBeUndefined();
  });
});

describe('#567 loop：方向锁定挂起与接力卡', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-direction-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-direction-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#direction-test', type: 'rnd',
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

  it('need_input + directions → planDirections/waitingReason 落档 + 里程碑带 plan_direction 卡', async () => {
    const wu = await setupPlanWu();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '方向锁定——请选定本票方向', directions: DIRECTION_PAYLOAD },
    );

    const parked = (await wuService.getById(wu.id))!;
    expect(parked.status).toBe('blocked');
    const meta: WorkUnitMetadata = JSON.parse(parked.metadata!);
    expect(meta.waitingForInput).toBe(true);
    expect(meta.waitingReason).toBe('plan-direction');
    expect(meta.planDirections).toEqual(DIRECTION_PAYLOAD);

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const question = messages.find(m => m.authorType === 'agent' && m.content.includes('需要输入'));
    expect(question).toBeDefined();
    const msgMeta = JSON.parse(question!.meta as string);
    expect(msgMeta.cardType).toBe('plan_direction');
  });

  it('directions 与 rulings 并存：direction 优先定 waitingReason/cardType，rulings 落档不动', async () => {
    const wu = await setupPlanWu();
    const rulings = [{ question: '存储选型？', suggestion: 'SQLite' }];

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '方向锁定', directions: DIRECTION_PAYLOAD, rulings },
    );

    const meta: WorkUnitMetadata = JSON.parse((await wuService.getById(wu.id))!.metadata!);
    expect(meta.waitingReason).toBe('plan-direction');
    expect(meta.planDirections).toEqual(DIRECTION_PAYLOAD);
    expect(meta.planRulings).toEqual(rulings);

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const question = messages.find(m => m.authorType === 'agent' && m.content.includes('需要输入'));
    expect(JSON.parse(question!.meta as string).cardType).toBe('plan_direction');
  });

  it('回归：无 directions 的 need_input 不落 planDirections/waitingReason、不带卡', async () => {
    const wu = await setupPlanWu();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '澄清：目标是内部工具还是对外产品？' },
    );

    const meta: WorkUnitMetadata = JSON.parse((await wuService.getById(wu.id))!.metadata!);
    expect(meta.waitingForInput).toBe(true);
    expect(meta.planDirections).toBeUndefined();
    expect(meta.waitingReason).toBeUndefined();

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const question = messages.find(m => m.authorType === 'agent' && m.content.includes('需要输入'));
    expect(JSON.parse(question!.meta as string).cardType).toBeUndefined();
  });
});
