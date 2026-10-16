/**
 * bootstrap/module-sinks（Phase 5 SCC 第一刀）— 装配期 sink 注入测试
 *
 * 覆盖：
 * - registerModuleSinks 把被调方实现注进各调用方注册口（依赖倒置：口子在调用方模块）
 * - 注入的闭包真实委托到被调方服务（audit-logs AuditService.log）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRegisterAuthAuditSink,
  mockAuditLog,
} = vi.hoisted(() => ({
  mockRegisterAuthAuditSink: vi.fn(),
  mockAuditLog: vi.fn(),
}));

vi.mock('../../modules/auth/index.js', () => ({
  registerAuthAuditSink: mockRegisterAuthAuditSink,
}));

vi.mock('../../modules/audit-logs/index.js', () => ({
  getAuditService: () => ({ log: mockAuditLog }),
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
});
