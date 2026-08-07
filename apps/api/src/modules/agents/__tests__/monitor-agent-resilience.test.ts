/**
 * MonitorService resilience tests
 *
 * 覆盖：超时 WorkUnit（>2.5h）自动终止（agentRunner.stop + close snapshot）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (hoisted by vitest) ──────────────────────────────────────────────
const {
  mockGetIndex,
  mockUpsertSnapshot,
  mockDaemonGetStatus,
} = vi.hoisted(() => ({
  mockGetIndex: vi.fn(() => Promise.resolve([])),
  mockUpsertSnapshot: vi.fn(() => Promise.resolve()),
  mockDaemonGetStatus: vi.fn(() => []),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    workUnit: { findMany: vi.fn(() => Promise.resolve([])), update: vi.fn(() => Promise.resolve({})) },
    $queryRaw: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  FileStore: class {
    getIndex = mockGetIndex;
    upsertSnapshot = mockUpsertSnapshot;
    removeSnapshot = vi.fn(() => Promise.resolve());
  },
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { stop: vi.fn(), execute: vi.fn() },
}));

vi.mock('@dommaker/harness', () => ({
  KnowledgeLinter: class { validateEntry() { return []; } },
  KnowledgeHealthScorer: class {},
  ReferenceTracker: class {},
  CheckpointValidator: { getInstance: () => ({ validate: () => [] }) },
}));

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  sharedStore: { list: vi.fn(() => []), save: vi.fn(), update: vi.fn(), delete: vi.fn() },
  sharedLifecycle: { recordReference: vi.fn() },
  sharedIngest: { ingestEntry: vi.fn() },
  sharedLinter: { validateEntry: vi.fn(() => []) },
  UNIFIED_KNOWLEDGE_DIR: '/tmp/test-knowledge',
  knowledgeBus: { search: vi.fn(() => []) },
}));

vi.mock('../../knowledge/knowledge-service.js', () => ({ knowledgeService: {} }));
vi.mock('../../knowledge/knowledge-sync.service.js', () => ({ knowledgeSync: {} }));
vi.mock('../../knowledge/preference-observer.js', () => ({ preferenceObserver: { record: vi.fn() } }));
vi.mock('../triage/triage.service.js', () => ({ triageService: { handleAlert: vi.fn() } }));

vi.mock('../../daemon/studio-daemon.js', () => ({
  daemon: { getStatus: mockDaemonGetStatus },
}));

import { monitorService } from '../monitor/monitor.service.js';
import { agentRunner } from '@dommaker/studio-agent';

/** Create minimal WorkUnitSnapshot for test fixtures */
function makeSnapshot(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'test-wu',
    parentId: null,
    type: 'task',
    scope: '',
    assigneeId: null,
    status: 'done',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    projectPath: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    claimedAt: null,
    completedAt: null,
    ...overrides,
  };
}

// ── Auto-fail time-critical workUnits (>2.5h) ──

describe('MonitorService auto-fail time-critical workUnits', () => {
  beforeEach(() => {
    mockGetIndex.mockReset();
    mockGetIndex.mockResolvedValue([]);
    mockUpsertSnapshot.mockReset();
    vi.mocked(agentRunner.stop).mockReset();
  });

  it('auto-fails workUnit exceeding 2.5h and calls agentRunner.stop', async () => {
    const execId = 'exec-timeout-test';
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    // Simulate workUnit claimed 3h ago (> TIME_CRITICAL_MS = 2.5h)
    mockGetIndex.mockResolvedValue([
      makeSnapshot({ id: execId, status: 'active', parentId: 'parent-1', claimedAt: threeHoursAgo, createdAt: threeHoursAgo }),
    ]);
    vi.mocked(agentRunner.stop).mockResolvedValue(undefined);

    const alerts = await (monitorService as any).checkTotalExecutionTime();

    // Should generate a critical alert
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'total_time',
        level: 'critical',
      }),
    ]));

    // Should call agentRunner.stop to kill the process
    expect(agentRunner.stop).toHaveBeenCalledWith(execId);

    // Should upsert snapshot with status 'closed'
    expect(mockUpsertSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: execId, status: 'closed' }),
    );
  });

  it('does not auto-fail workUnit under 2.5h', async () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    // Simulate workUnit claimed 1h ago (< TIME_CRITICAL_MS)
    mockGetIndex.mockResolvedValue([
      makeSnapshot({ id: 'exec-ok', status: 'active', parentId: 'parent-1', claimedAt: oneHourAgo, createdAt: oneHourAgo }),
    ]);

    const alerts = await (monitorService as any).checkTotalExecutionTime();

    // Should NOT call agentRunner.stop
    expect(agentRunner.stop).not.toHaveBeenCalled();

    // Should NOT upsert status
    expect(mockUpsertSnapshot).not.toHaveBeenCalled();

    // Should generate info alert (1h < TIME_WARN_MS would be info level)
    const criticalAlerts = alerts.filter((a: any) => a.level === 'critical');
    expect(criticalAlerts.length).toBe(0);
  });
});

