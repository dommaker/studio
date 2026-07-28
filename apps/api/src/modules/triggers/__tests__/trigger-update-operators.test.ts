// P0 修复（WU 超时机制 b/c）：UPDATE action 查询匹配支持 { lt, gt, lte, gte } 操作符
// （ISO 时间字符串/数值），'$now' 占位符在执行时刻求值（不再冻结在注册时）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeUpdateAction, matchesQueryValue, NOW_PLACEHOLDER } from '../trigger-action';
import type { TriggerAction } from '../trigger.types';

// Mock FileStore so trigger-action module uses a controlled instance
const mockFileStore = vi.hoisted(() => ({
  getIndex: vi.fn(),
  upsertSnapshot: vi.fn(),
  appendEvent: vi.fn(),
  removeSnapshot: vi.fn(),
  claimWorkUnit: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    FileStore: vi.fn(function () { return mockFileStore; }),
  };
});

const NOW = '2026-07-27T12:00:00.000Z';

describe('matchesQueryValue（P0：操作符比较）', () => {
  it('浅层全等保持原行为', () => {
    expect(matchesQueryValue('active', 'active', NOW)).toBe(true);
    expect(matchesQueryValue('active', 'blocked', NOW)).toBe(false);
    expect(matchesQueryValue(null, null, NOW)).toBe(true);
  });

  it('ISO 时间字符串 lt/gt/lte/gte', () => {
    const past = '2026-07-27T11:00:00.000Z';
    const future = '2026-07-27T13:00:00.000Z';
    expect(matchesQueryValue(past, { lt: NOW }, NOW)).toBe(true);
    expect(matchesQueryValue(future, { lt: NOW }, NOW)).toBe(false);
    expect(matchesQueryValue(future, { gt: NOW }, NOW)).toBe(true);
    expect(matchesQueryValue(NOW, { lte: NOW }, NOW)).toBe(true);
    expect(matchesQueryValue(NOW, { gte: NOW }, NOW)).toBe(true);
    expect(matchesQueryValue(past, { gt: NOW }, NOW)).toBe(false);
  });

  it('数值比较（任一侧为数值 → 数值口径）', () => {
    expect(matchesQueryValue(3, { lt: 5 }, NOW)).toBe(true);
    expect(matchesQueryValue(5, { lt: 5 }, NOW)).toBe(false);
    expect(matchesQueryValue('7', { gt: 5 }, NOW)).toBe(true);
    expect(matchesQueryValue(5, { gte: 5 }, NOW)).toBe(true);
  });

  it('多操作符须全部满足（区间）', () => {
    expect(matchesQueryValue(5, { gte: 1, lt: 10 }, NOW)).toBe(true);
    expect(matchesQueryValue(15, { gte: 1, lt: 10 }, NOW)).toBe(false);
  });

  it('actual 为 null/undefined → 操作符比较恒 false（不超时字段不命中）', () => {
    expect(matchesQueryValue(null, { lt: NOW }, NOW)).toBe(false);
    expect(matchesQueryValue(undefined, { lt: NOW }, NOW)).toBe(false);
  });

  it('非操作符对象回落全等（引用不等 → false）', () => {
    expect(matchesQueryValue('x', { foo: 1 } as unknown, NOW)).toBe(false);
  });

  it("'$now' 占位符在执行时刻求值", () => {
    expect(matchesQueryValue('2026-07-27T11:00:00.000Z', { lt: NOW_PLACEHOLDER }, NOW)).toBe(true);
    expect(matchesQueryValue('2026-07-27T13:00:00.000Z', { lt: NOW_PLACEHOLDER }, NOW)).toBe(false);
  });
});

describe('executeUpdateAction（P0：操作符查询集成）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function wuSnapshot(id: string, timeoutAt: string | null) {
    return {
      id,
      parentId: null,
      type: 'task',
      scope: `scope-${id}`,
      assigneeId: 'agent-1',
      status: 'active',
      failureType: null,
      retryCount: 0,
      timeoutAt,
      channelId: null,
      projectPath: null,
      metadata: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      completedAt: null,
    };
  }

  it("timeoutAt { lt: '$now' } 只命中已超时的 active WU", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    mockFileStore.getIndex.mockResolvedValue([
      wuSnapshot('wu-expired', past),
      wuSnapshot('wu-fresh', future),
      wuSnapshot('wu-no-timeout', null),
    ]);

    const action: TriggerAction = {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { status: 'active', timeoutAt: { lt: NOW_PLACEHOLDER } },
        update: { status: 'unassigned', assigneeId: null },
      },
    };

    await executeUpdateAction(action, {});

    expect(mockFileStore.upsertSnapshot).toHaveBeenCalledTimes(1);
    const updated = mockFileStore.upsertSnapshot.mock.calls[0][0];
    expect(updated.id).toBe('wu-expired');
    expect(updated.status).toBe('unassigned');
    expect(updated.assigneeId).toBeNull();
  });
});
