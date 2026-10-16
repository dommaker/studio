/**
 * auth/audit-sink（Phase 5 SCC 第一刀 #1）— 审计出口缝语义测试
 *
 * 覆盖：
 * - 注册后 logAuthAudit 委托给注入的 sink（bootstrap 装配注入 audit-logs 实现）
 * - 未注册 → warn 一次 + 静默丢弃（no-op resolve，不阻断调用方）
 * - registerAuthAuditSink(null) 复位到未注册态
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return { ...actual, logger: mockLogger };
});

import { logAuthAudit, registerAuthAuditSink } from '../audit-sink.js';

const ENTRY = {
  userId: 'u1', sessionId: 's1', action: 'login', resource: 'session', status: 'success' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  registerAuthAuditSink(null);
});

describe('auth/audit-sink', () => {
  it('注册后委托给注入的 sink', async () => {
    const sink = vi.fn().mockResolvedValue({ id: 'log-1' });
    registerAuthAuditSink(sink);

    await expect(logAuthAudit(ENTRY)).resolves.toEqual({ id: 'log-1' });
    expect(sink).toHaveBeenCalledWith(ENTRY);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('未注册 → warn 一次 + 静默丢弃，不抛错', async () => {
    await expect(logAuthAudit(ENTRY)).resolves.toBeUndefined();
    await expect(logAuthAudit(ENTRY)).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('未注册'));
  });

  it('sink 抛错原样透传（routes.ts 侧 .catch 降级口径不变）', async () => {
    registerAuthAuditSink(() => Promise.reject(new Error('audit db error')));

    await expect(logAuthAudit(ENTRY)).rejects.toThrow('audit db error');
  });
});
