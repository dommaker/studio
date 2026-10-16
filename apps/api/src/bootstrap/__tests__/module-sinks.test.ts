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
  mockAuditLog,
  mockCreateAgentMessage,
} = vi.hoisted(() => ({
  mockRegisterAuthAuditSink: vi.fn(),
  mockRegisterAlertChannelPoster: vi.fn(),
  mockAuditLog: vi.fn(),
  mockCreateAgentMessage: vi.fn(),
}));

vi.mock('../../modules/auth/index.js', () => ({
  registerAuthAuditSink: mockRegisterAuthAuditSink,
}));

vi.mock('../../modules/notifications/index.js', () => ({
  registerAlertChannelPoster: mockRegisterAlertChannelPoster,
}));

vi.mock('../../modules/audit-logs/index.js', () => ({
  getAuditService: () => ({ log: mockAuditLog }),
}));

vi.mock('../../modules/channels/index.js', () => ({
  getChannelMessageService: () => ({ createAgentMessage: mockCreateAgentMessage }),
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
});
