/**
 * audit-logs/agent-decision (#591 B 类) — recordAgentDecision 统一入口测试
 *
 * 契约：actorType 缺省 agent；actor.type=human → userId 承载、agent → roleId 承载；
 * status 缺省 success；log 失败只记日志不抛出（fire-and-forget，不阻断业务链路）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLog } = vi.hoisted(() => ({ mockLog: vi.fn() }));

vi.mock('@dommaker/studio-audit', () => ({
  AuditService: vi.fn().mockImplementation(function () {
    return { log: mockLog };
  }),
}));

import { recordAgentDecision } from '../agent-decision.js';

describe('recordAgentDecision (#591)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLog.mockResolvedValue(undefined);
  });

  it('缺省 actor → actorType=agent，userId/roleId 均不带', () => {
    recordAgentDecision({ action: 'auto_apply', resource: 'skill_status', resourceId: 'sk-1' });

    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'agent',
      action: 'auto_apply',
      resource: 'skill_status',
      resourceId: 'sk-1',
      status: 'success',
      userId: undefined,
      roleId: undefined,
    }));
  });

  it('actor.type=agent → roleId 承载主体', () => {
    recordAgentDecision({
      action: 'claim', resource: 'workunit', resourceId: 'wu-1',
      actor: { id: 'inst-1', type: 'agent' },
    });

    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'agent', roleId: 'inst-1', userId: undefined,
    }));
  });

  it('actor.type=human → userId 承载主体', () => {
    recordAgentDecision({
      action: 'transition', resource: 'workunit', resourceId: 'wu-1',
      actor: { id: 'user-1', type: 'human' },
    });

    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'human', userId: 'user-1', roleId: undefined,
    }));
  });

  it('details/requestId/status 透传', () => {
    recordAgentDecision({
      action: 'dispatch', resource: 'workunit', resourceId: 'wu-1',
      status: 'failure',
      details: { via: 'mention', basis: 'x' },
      requestId: 'trace-1',
    });

    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failure',
      details: { via: 'mention', basis: 'x' },
      requestId: 'trace-1',
    }));
  });

  it('log 失败只记日志不抛出（fire-and-forget）', async () => {
    mockLog.mockRejectedValue(new Error('disk full'));

    expect(() => recordAgentDecision({ action: 'claim', resource: 'workunit' })).not.toThrow();
    // 让 rejected promise 的 catch 跑完，确认无 unhandled rejection
    await new Promise(resolve => setImmediate(resolve));
  });
});
