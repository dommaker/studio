/**
 * bootstrap/module-sinks（Phase 5 SCC 第一刀）— 装配期 sink 注入测试
 *
 * 覆盖：
 * - registerModuleSinks 把被调方实现注进各调用方注册口（依赖倒置：口子在调用方模块）
 * - 注入的闭包真实委托到被调方服务（audit-logs AuditService.log /
 *   channels ChannelMessageService.createAgentMessage）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRegisterAuthAuditSink,
  mockRegisterAlertChannelPoster,
  mockRegisterChannelCardPoster,
  mockRegisterWorkUnitPorts,
  mockAuditLog,
  mockRecordAgentDecision,
  mockCreateAgentMessage,
  mockCreateCardMessage,
  mockResolvePmoId,
  mockSelectProjectSnapshots,
  mockRunVerification,
  mockDispatchReview,
} = vi.hoisted(() => ({
  mockRegisterAuthAuditSink: vi.fn(),
  mockRegisterAlertChannelPoster: vi.fn(),
  mockRegisterChannelCardPoster: vi.fn(),
  mockRegisterWorkUnitPorts: vi.fn(),
  mockAuditLog: vi.fn(),
  mockRecordAgentDecision: vi.fn(),
  mockCreateAgentMessage: vi.fn(),
  mockCreateCardMessage: vi.fn(),
  mockResolvePmoId: vi.fn(),
  mockSelectProjectSnapshots: vi.fn(),
  mockRunVerification: vi.fn(),
  mockDispatchReview: vi.fn(),
}));

vi.mock('../../modules/auth/index.js', () => ({
  registerAuthAuditSink: mockRegisterAuthAuditSink,
}));

vi.mock('../../modules/notifications/index.js', () => ({
  registerAlertChannelPoster: mockRegisterAlertChannelPoster,
}));

vi.mock('../../modules/review-proposal/index.js', () => ({
  registerChannelCardPoster: mockRegisterChannelCardPoster,
}));

vi.mock('../../modules/workunit/index.js', () => ({
  registerWorkUnitPorts: mockRegisterWorkUnitPorts,
}));
const mockRegisterWorkUnitSinks = vi.hoisted(() => vi.fn());
vi.mock('../workunit-sinks.js', () => ({ registerWorkUnitSinks: mockRegisterWorkUnitSinks }));
const mockRegisterProjectReadSink = vi.hoisted(() => vi.fn());
vi.mock('../project-read-sinks.js', () => ({ registerProjectReadSink: mockRegisterProjectReadSink }));

vi.mock('../../modules/audit-logs/index.js', () => ({
  getAuditService: () => ({ log: mockAuditLog }),
  recordAgentDecision: mockRecordAgentDecision,
}));

vi.mock('../../modules/channels/index.js', () => ({
  ChannelMessageService: function ChannelMessageService() {
    return {
      createAgentMessage: mockCreateAgentMessage,
      createHumanMessage: vi.fn(),
      updateMessage: vi.fn(),
      listByWorkUnitId: vi.fn(),
      linkWorkUnit: vi.fn(),
    };
  },
  getChannelMessageService: () => ({ createAgentMessage: mockCreateAgentMessage, createCardMessage: mockCreateCardMessage }),
  resolveOrNotice: vi.fn(),
}));

vi.mock('../../modules/requirements/index.js', () => ({
  RequirementService: vi.fn(),
  resolvePmoProjectIdForWU: mockResolvePmoId,
}));

vi.mock('../../modules/pmo/index.js', () => ({
  applyPlanDirection: vi.fn(), applyPlanRuling: vi.fn(),
  PlanDirectionError: class PlanDirectionError extends Error {},
  PlanRulingError: class PlanRulingError extends Error {},
  projectService: {}, selectProjectSnapshots: mockSelectProjectSnapshots,
  validateDirectionPick: vi.fn(), validateRulingItems: vi.fn(),
}));

vi.mock('../../modules/agent-loop/index.js', () => ({
  getReviewDispatcher: () => ({ dispatchReviewNow: mockDispatchReview }),
}));
vi.mock('../../modules/agents/index.js', () => ({
  aggregateTreeTokens: vi.fn(), getSystemExecutor: vi.fn(),
}));
vi.mock('../../modules/ops/index.js', () => ({ dispatchMonitorAlerts: vi.fn() }));
vi.mock('../../core/wu-verification.js', () => ({
  CODE_WORKTREE_TYPES: new Set(['task']),
  resolveVerifyCommands: vi.fn(),
  runWuVerification: mockRunVerification,
}));

import { registerModuleSinks } from '../module-sinks.js';

beforeEach(() => {
  vi.clearAllMocks();
  registerModuleSinks();
});

describe('bootstrap/module-sinks 装配', () => {
  it('auth 审计 sink：注入闭包委托 AuditService.log', async () => {
    expect(mockRegisterAuthAuditSink).toHaveBeenCalledTimes(1);
    const sink = mockRegisterAuthAuditSink.mock.calls[0][0];
    mockAuditLog.mockResolvedValue({ id: 'log-1' });

    await expect(sink({ action: 'login', resource: 'session', status: 'success' })).resolves.toEqual({ id: 'log-1' });
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'login' }));
  });

  it('notifications 告警频道 poster：注入闭包委托 createAgentMessage（atHuman 映射 meta.atHuman）', async () => {
    expect(mockRegisterAlertChannelPoster).toHaveBeenCalledTimes(1);
    const poster = mockRegisterAlertChannelPoster.mock.calls[0][0];
    mockCreateAgentMessage.mockResolvedValue({ id: 'msg-1' });

    await poster({ channelId: 'ch-1', content: 'body', atHuman: true });
    expect(mockCreateAgentMessage).toHaveBeenCalledWith('ch-1', 'Studio', 'body', { meta: { atHuman: true } });

    await poster({ channelId: 'ch-1', content: 'body', atHuman: false });
    expect(mockCreateAgentMessage).toHaveBeenLastCalledWith('ch-1', 'Studio', 'body', undefined);
  });

  it('review-proposal 卡 poster：注入闭包委托 createCardMessage（参数原样透传）', async () => {
    expect(mockRegisterChannelCardPoster).toHaveBeenCalledTimes(1);
    const poster = mockRegisterChannelCardPoster.mock.calls[0][0];
    mockCreateCardMessage.mockResolvedValue({ id: 'msg-2' });

    await poster({ channelId: 'ch-sys', author: 'KK', content: 'md', cardType: 'distill_proposal', cardData: { proposalId: 'p-1' } });
    expect(mockCreateCardMessage).toHaveBeenCalledWith('ch-sys', 'KK', 'md', 'distill_proposal', { proposalId: 'p-1' });
  });

  it('ARCH-02/04 跨域读口装配委托独立组合步骤', () => {
    expect(mockRegisterProjectReadSink).toHaveBeenCalledTimes(1);
    expect(mockRegisterWorkUnitSinks).toHaveBeenCalledTimes(1);
  });
});
