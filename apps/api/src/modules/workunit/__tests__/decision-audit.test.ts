/**
 * #591 B 类：WU 状态机流转决策埋点（词表 transition，落 audit-logs 轨）
 *
 * 埋点位置 = 迁移类写唯一尾部 persistSnapshot（单点覆盖 transitionStatus / close /
 * reviewPassed / reviewRejected / blockFor*）。actor 优先调用方透传
 * （REST=human、agent-loop=agent、review*=attestation 来源、close=closedBy 映射），
 * 缺省按 assigneeId 命中 agent 状态库派生。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';

const { decisionSpy } = vi.hoisted(() => ({ decisionSpy: vi.fn() }));
vi.mock('../../audit-logs/agent-decision.js', () => ({ recordAgentDecision: decisionSpy }));

// 与 claim-announce.test.ts 同范式：mock 掉执行/知识链，真实 FileStore + WorkUnitService
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

describe('WU 状态机流转埋点（#591 transition）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-decision-audit-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function writeAgentState(instanceId: string) {
    fs.mkdirSync(path.join(testDir, 'agents', instanceId), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'agents', instanceId, 'state.json'), JSON.stringify({ roleId: 'role-x' }));
  }

  it('transitionStatus 带 human actor（REST 人工流转）→ 落 transition 行（from/to/eventType）', async () => {
    const wu = await wuService.create({ scope: 's', type: 'task', status: 'unassigned' });

    await wuService.transitionStatus(wu.id, 'active', { id: 'user-1', type: 'human' });

    expect(decisionSpy).toHaveBeenCalledTimes(1);
    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'transition',
      resource: 'workunit',
      resourceId: wu.id,
      actor: { id: 'user-1', type: 'human' },
      details: { from: 'unassigned', to: 'active', eventType: 'updated' },
    }));
  });

  it('transitionStatus 不带 actor：assigneeId 命中 agent 状态库 → 派生 agent；WU traceId 透传 requestId', async () => {
    writeAgentState('instance-t1');
    const wu = await wuService.create({
      scope: 's', type: 'task', status: 'unassigned',
      metadata: { traceId: 'trace-trans-1' },
    });
    await wuService.claim(wu.id, 'instance-t1');
    decisionSpy.mockClear(); // claim 不经 persistSnapshot，此处无埋点；清掉噪音防误断言

    await wuService.transitionStatus(wu.id, 'in_review');

    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'transition',
      actor: { id: 'instance-t1', type: 'agent' },
      details: { from: 'active', to: 'in_review', eventType: 'updated' },
      requestId: 'trace-trans-1',
    }));
  });

  it('close：closedBy=human-command → human；系统看守（total-time-kill）→ agent', async () => {
    const wu1 = await wuService.create({ scope: 's1', type: 'task', status: 'unassigned' });
    await wuService.transitionStatus(wu1.id, 'active');
    const wu2 = await wuService.create({ scope: 's2', type: 'task', status: 'unassigned' });
    await wuService.transitionStatus(wu2.id, 'active');
    decisionSpy.mockClear();

    await wuService.close(wu1.id, { reason: '人指令关闭', closedBy: 'human-command' });
    await wuService.close(wu2.id, { reason: '超时强杀', closedBy: 'total-time-kill' });

    expect(decisionSpy).toHaveBeenCalledTimes(2);
    expect(decisionSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: 'transition', resourceId: wu1.id,
      actor: { id: 'human-command', type: 'human' },
      details: expect.objectContaining({ from: 'active', to: 'closed' }),
    }));
    expect(decisionSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'transition', resourceId: wu2.id,
      actor: { id: 'total-time-kill', type: 'agent' },
    }));
  });

  it('close 幂等（已是 closed）→ 不重复落账', async () => {
    const wu = await wuService.create({ scope: 's', type: 'task', status: 'unassigned' });
    await wuService.transitionStatus(wu.id, 'active');
    await wuService.close(wu.id, { reason: 'r', closedBy: 'human-command' });
    decisionSpy.mockClear();

    await wuService.close(wu.id, { reason: 'r', closedBy: 'human-command' });

    expect(decisionSpy).not.toHaveBeenCalled();
  });

  it('reviewPassed：attestation 来源定 actorType（agent-review → agent）', async () => {
    writeAgentState('instance-r1');
    const wu = await wuService.create({ scope: 's', type: 'task', status: 'unassigned' });
    await wuService.claim(wu.id, 'instance-r1');
    await wuService.transitionStatus(wu.id, 'in_review');
    decisionSpy.mockClear();

    await wuService.reviewPassed(wu.id, { kind: 'agent-review', by: 'reviewer-bot' });

    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'transition',
      actor: { id: 'reviewer-bot', type: 'agent' },
      details: { from: 'in_review', to: 'done', eventType: 'completed' },
    }));
  });

  it('reviewRejected：human-confirm 来源 → human actor', async () => {
    writeAgentState('instance-r2');
    const wu = await wuService.create({ scope: 's', type: 'task', status: 'unassigned' });
    await wuService.claim(wu.id, 'instance-r2');
    await wuService.transitionStatus(wu.id, 'in_review');
    decisionSpy.mockClear();

    await wuService.reviewRejected(wu.id, '不行', { kind: 'human-confirm', by: 'user-9' });

    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'transition',
      actor: { id: 'user-9', type: 'human' },
      details: expect.objectContaining({ from: 'in_review', to: 'active' }),
    }));
  });

  it('非状态迁移的 persistSnapshot（recordL1Verification 台账补写）→ 不落账', async () => {
    const wu = await wuService.create({ scope: 's', type: 'task', status: 'unassigned' });
    decisionSpy.mockClear();

    await wuService.recordL1Verification(wu.id, { by: 'user-1', ran: ['pnpm test'], source: 'convention' });

    expect(decisionSpy).not.toHaveBeenCalled();
  });
});
