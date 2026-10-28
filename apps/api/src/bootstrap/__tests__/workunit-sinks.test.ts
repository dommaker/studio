/** ARCH-02 WorkUnit 组合步骤：八类端口与真实模块实现的委托关系。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRegisterWorkUnitPorts,
  mockRecordAgentDecision,
  mockCreateAgentMessage,
  mockResolvePmoId,
  mockRunVerification,
  mockDispatchReview,
} = vi.hoisted(() => ({
  mockRegisterWorkUnitPorts: vi.fn(),
  mockRecordAgentDecision: vi.fn(),
  mockCreateAgentMessage: vi.fn(),
  mockResolvePmoId: vi.fn(),
  mockRunVerification: vi.fn(),
  mockDispatchReview: vi.fn(),
}));

vi.mock('../../modules/workunit/index.js', () => ({ registerWorkUnitPorts: mockRegisterWorkUnitPorts }));
vi.mock('../../modules/audit-logs/index.js', () => ({ recordAgentDecision: mockRecordAgentDecision }));
vi.mock('../../modules/channels/index.js', () => ({
  ChannelMessageService: function ChannelMessageService() {
    return {
      createAgentMessage: mockCreateAgentMessage,
      createHumanMessage: vi.fn(), updateMessage: vi.fn(), listByWorkUnitId: vi.fn(), linkWorkUnit: vi.fn(),
    };
  },
  resolveOrNotice: vi.fn(),
}));
vi.mock('../../modules/requirements/index.js', () => ({
  RequirementService: vi.fn(), resolvePmoProjectIdForWU: mockResolvePmoId,
}));
vi.mock('../../modules/pmo/index.js', () => ({
  applyPlanDirection: vi.fn(), applyPlanRuling: vi.fn(),
  PlanDirectionError: class PlanDirectionError extends Error {},
  PlanRulingError: class PlanRulingError extends Error {},
  projectService: {}, selectProjectSnapshots: vi.fn(),
  validateDirectionPick: vi.fn(), validateRulingItems: vi.fn(),
}));
vi.mock('../../modules/agent-loop/index.js', () => ({
  getReviewDispatcher: () => ({ dispatchReviewNow: mockDispatchReview }),
}));
vi.mock('../../modules/agents/index.js', () => ({ aggregateTreeTokens: vi.fn(), getSystemExecutor: vi.fn() }));
vi.mock('../../modules/ops/index.js', () => ({ dispatchMonitorAlerts: vi.fn() }));
vi.mock('../../core/wu-verification.js', () => ({
  CODE_WORKTREE_TYPES: new Set(['task']), resolveVerifyCommands: vi.fn(), runWuVerification: mockRunVerification,
}));

import { registerWorkUnitSinks } from '../workunit-sinks.js';

beforeEach(() => {
  vi.clearAllMocks();
  registerWorkUnitSinks();
});

describe('bootstrap/workunit-sinks', () => {
  it('八类端口均装配，闭包委托对应模块实现', async () => {
    expect(mockRegisterWorkUnitPorts).toHaveBeenCalledTimes(1);
    const ports = mockRegisterWorkUnitPorts.mock.calls[0][0];
    expect(Object.keys(ports).sort()).toEqual([
      'alert', 'audit', 'execution', 'message', 'projectRead', 'read', 'review', 'verification',
    ]);

    const fileStore = { id: 'fs' };
    mockCreateAgentMessage.mockResolvedValue({ id: 'msg-wu' });
    await ports.message.createAgentMessage({ fileStore, channelId: 'ch-wu', agentName: 'Studio', content: 'body' });
    expect(mockCreateAgentMessage).toHaveBeenCalledWith('ch-wu', 'Studio', 'body', {
      replyToId: undefined, meta: undefined, workUnitId: undefined,
    });

    mockResolvePmoId.mockResolvedValue('pmo-1');
    await expect(ports.projectRead.resolvePmoId({ reqId: 'req-1' }, fileStore)).resolves.toBe('pmo-1');
    mockRunVerification.mockResolvedValue({ ran: [], source: 'convention' });
    await ports.verification.run({ id: 'wu-1' }, {}, '/capability/cwd');
    expect(mockRunVerification).toHaveBeenCalledWith({ id: 'wu-1' }, {}, '/capability/cwd');
    mockDispatchReview.mockResolvedValue({ id: 'review-1' });
    await expect(ports.review.dispatchReviewNow('wu-1')).resolves.toEqual({ id: 'review-1' });
    ports.audit({ action: 'claim', resource: 'workunit' });
    expect(mockRecordAgentDecision).toHaveBeenCalledWith({ action: 'claim', resource: 'workunit' });
  });
});
