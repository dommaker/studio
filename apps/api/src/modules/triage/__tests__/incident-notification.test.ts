// incident-notification（#468 行动中心）：incident.created/escalated 落 NotificationService
// 取代修复断裂的 SSE 桥（incident 发裸频道、sse.routes 只订 events，TriageBanner 实际收不到）。
// 覆盖：created/escalated 两形态、severity 进 content、wuId 透传、写失败吞掉不抛。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateForAllUsers, mockLogger } = vi.hoisted(() => ({
  mockCreateForAllUsers: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dommaker/studio-notification', () => ({
  notificationService: { createForAllUsers: mockCreateForAllUsers },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: mockLogger,
}));

import { persistIncidentNotification } from '../incident-notification.js';

describe('persistIncidentNotification（#468）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateForAllUsers.mockResolvedValue(1);
  });

  it('created：落 incident 通知，severity 进 content，wuId/直链透传', async () => {
    await persistIncidentNotification('created', {
      incidentId: 'I-1',
      severity: 'warning',
      summary: 'execution_stuck: wu 卡住',
      wuId: 'wu-9',
    });

    expect(mockCreateForAllUsers).toHaveBeenCalledTimes(1);
    expect(mockCreateForAllUsers).toHaveBeenCalledWith(expect.objectContaining({
      type: 'incident',
      wuId: 'wu-9',
      link: '/workunits/wu-9',
    }));
    const arg = mockCreateForAllUsers.mock.calls[0][0];
    expect(arg.content).toContain('severity: warning');
    expect(arg.content).toContain('execution_stuck');
  });

  it('escalated：缺省 severity=critical（升级人工即横幅突破口径）', async () => {
    await persistIncidentNotification('escalated', { incidentId: 'I-2', summary: 'Max attempts exhausted' });

    const arg = mockCreateForAllUsers.mock.calls[0][0];
    expect(arg.type).toBe('incident');
    expect(arg.content).toContain('severity: critical');
  });

  it('写入失败 → warn 吞掉，不向调用方抛错', async () => {
    mockCreateForAllUsers.mockRejectedValue(new Error('jsonl locked'));

    await expect(
      persistIncidentNotification('created', { incidentId: 'I-3', summary: 'x' }),
    ).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('incident notification'),
      expect.objectContaining({ error: expect.stringContaining('jsonl locked') }),
    );
  });
});
