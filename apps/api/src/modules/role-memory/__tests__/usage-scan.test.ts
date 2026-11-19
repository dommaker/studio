import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkUnitSnapshot } from '@dommaker/studio-shared';

const {
  mockConsumeTranscript,
  mockReconcile,
  mockSubscribe,
  mockReadTopic,
  mockRecordUsage,
  state,
} = vi.hoisted(() => ({
  mockConsumeTranscript: vi.fn(),
  mockReconcile: vi.fn().mockResolvedValue(undefined),
  mockSubscribe: vi.fn(),
  mockReadTopic: vi.fn(),
  mockRecordUsage: vi.fn().mockResolvedValue(undefined),
  state: { statusChangedHandler: null as null | ((payload: { workunit: unknown; previousStatus?: string }) => void) },
}));

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    eventBus: {
      subscribe: (event: string, handler: (payload: { workunit: unknown; previousStatus?: string }) => void) => {
        mockSubscribe(event, handler);
        if (event === 'workunit.status_changed') state.statusChangedHandler = handler;
      },
    },
  };
});

vi.mock('../../transcripts/transcript-archive.js', () => ({
  consumeTranscript: mockConsumeTranscript,
  reconcileTranscriptAssignments: mockReconcile,
}));

vi.mock('../role-memory.js', () => ({
  roleMemoryStore: { readTopic: mockReadTopic, recordUsage: mockRecordUsage },
}));

vi.mock('../review-adapter.js', () => ({
  registerMemoryReviewAdapter: vi.fn(),
  submitMemoryProposal: vi.fn(),
}));

import { extractUsedMemoryTopics, RoleMemoryUsageScanner } from '../usage-scan.js';

const memoryStore = { readTopic: mockReadTopic, recordUsage: mockRecordUsage };

function finalSnapshot(overrides: Partial<WorkUnitSnapshot> = {}): WorkUnitSnapshot {
  return {
    id: 'wu-1',
    type: 'task',
    status: 'done',
    assigneeId: 'instance-1',
    projectPath: '/repo/project',
    metadata: null,
    currentAssignmentId: 'assignment-final',
    assignments: [
      { id: 'assignment-old', status: 'succeeded' },
      { id: 'assignment-final', status: 'succeeded' },
    ],
    stepRecords: [{
      id: 'step-final',
      assignmentId: 'assignment-final',
      at: '2026-01-01T00:00:00.000Z',
      verification: { status: 'passed' },
    }],
    ...overrides,
  } as WorkUnitSnapshot;
}

function mockCommitted(entries: Array<Record<string, unknown>>): void {
  mockConsumeTranscript.mockImplementation(async (_wuId, _consumer, consume) => ({
    value: await consume(entries),
    consumed: entries.length,
    hasUncommitted: false,
    hasWriting: false,
  }));
}

function makeFileStore(snapshot: WorkUnitSnapshot): FileStoreDouble {
  return {
    getIndex: vi.fn().mockResolvedValue([snapshot]),
    getProfile: vi.fn().mockResolvedValue(null),
    getState: vi.fn().mockResolvedValue({ roleId: 'role-a' }),
    listCurrentSnapshots: vi.fn().mockResolvedValue([snapshot]),
  };
}

interface FileStoreDouble {
  getIndex: ReturnType<typeof vi.fn>;
  getProfile: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  listCurrentSnapshots: ReturnType<typeof vi.fn>;
}

describe('extractUsedMemoryTopics（#718）', () => {
  it('从 rawOutput 提取全路径和相对 topics 路径，去重且不把 MEMORY.md 索引算作使用', () => {
    expect(extractUsedMemoryTopics([
      'Read /data/memory/role-a/topics/code-review.md',
      'cat memory/role-a/topics/code-review.md',
      'Read topics/testing.md',
      'Read memory/role-b/topics/other-role.md',
      'Read memory/role-a/MEMORY.md',
    ].join('\n'))).toEqual([
      { roleId: 'role-a', slug: 'code-review' },
      { slug: 'testing' },
      { roleId: 'role-b', slug: 'other-role' },
    ]);
  });
});

describe('RoleMemoryUsageScanner（#718）', () => {
  let snapshot: WorkUnitSnapshot;
  let fileStore: FileStoreDouble;
  let scanner: RoleMemoryUsageScanner;

  beforeEach(() => {
    vi.clearAllMocks();
    state.statusChangedHandler = null;
    snapshot = finalSnapshot();
    fileStore = makeFileStore(snapshot);
    scanner = new RoleMemoryUsageScanner(fileStore as never, memoryStore as never);
    mockCommitted([]);
    mockReadTopic.mockImplementation(async (_roleId, slug) => slug === 'missing' ? null : { slug });
    mockRecordUsage.mockResolvedValue(undefined);
  });

  it('按 WU assignee 的 state.roleId 写回真实 topic，并关联最终 Assignment/StepRecord/verification', async () => {
    mockCommitted([{
      workUnitId: 'wu-1', step: 1,
      rawOutput: 'Read memory/role-a/topics/code-review.md；再读 topics/testing.md 与 topics/missing.md',
    }]);

    await expect(scanner.scan({ id: 'wu-1' } as never)).resolves.toEqual(['code-review', 'testing']);
    expect(mockReadTopic).toHaveBeenCalledWith('role-a', 'code-review');
    expect(mockReadTopic).toHaveBeenCalledWith('role-a', 'testing');
    expect(mockRecordUsage).toHaveBeenCalledTimes(2);
    expect(mockRecordUsage).toHaveBeenNthCalledWith(1, 'role-a', 'code-review', {
      workUnitId: 'wu-1',
      assignmentId: 'assignment-final',
      stepRecordId: 'step-final',
      at: '2026-01-01T00:00:00.000Z',
      verification: 'passed',
    });
    expect(mockRecordUsage).not.toHaveBeenCalledWith('role-a', 'missing', expect.anything());
  });

  it('按 transcript entry 的 Assignment 归因使用与该轮最终验证，不错记到当前 Assignment', async () => {
    snapshot = finalSnapshot({
      stepRecords: [
        { id: 'step-old', assignmentId: 'assignment-old', at: '2025-12-31T00:00:00.000Z', verification: { status: 'failed' } },
        { id: 'step-final', assignmentId: 'assignment-final', at: '2026-01-01T00:00:00.000Z', verification: { status: 'passed' } },
      ],
    } as WorkUnitSnapshot);
    fileStore = makeFileStore(snapshot);
    scanner = new RoleMemoryUsageScanner(fileStore as never, memoryStore as never);
    mockCommitted([{
      workUnitId: 'wu-1', assignmentId: 'assignment-old', step: 1,
      rawOutput: 'Read topics/code-review.md',
    }]);

    await scanner.scan({ id: 'wu-1' } as never);

    expect(mockRecordUsage).toHaveBeenCalledWith('role-a', 'code-review', {
      workUnitId: 'wu-1', assignmentId: 'assignment-old', stepRecordId: 'step-old',
      at: '2025-12-31T00:00:00.000Z', verification: 'failed',
    });
  });

  it('无路径命中、索引注入或跨角色路径均不写使用记录', async () => {
    mockCommitted([
      { workUnitId: 'wu-1', step: 1, rawOutput: '普通输出；memory/role-a/MEMORY.md' },
      { workUnitId: 'wu-1', step: 2, rawOutput: 'Read memory/role-b/topics/code-review.md' },
    ]);

    await expect(scanner.scan({ id: 'wu-1' } as never)).resolves.toEqual([]);
    expect(mockReadTopic).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('recordUsage 失败向外抛出，role-memory-usage committed watermark 不推进', async () => {
    let watermarkCommitted = false;
    mockConsumeTranscript.mockImplementation(async (_wuId, _consumer, consume) => {
      const value = await consume([{ workUnitId: 'wu-1', step: 1, rawOutput: 'topics/code-review.md' }]);
      watermarkCommitted = true;
      return { value, consumed: 1, hasUncommitted: false, hasWriting: false };
    });
    mockRecordUsage.mockRejectedValueOnce(new Error('topic write failed'));

    await expect(scanner.scan({ id: 'wu-1' } as never)).rejects.toThrow('topic write failed');
    expect(watermarkCommitted).toBe(false);
    expect(mockConsumeTranscript).toHaveBeenCalledWith('wu-1', 'role-memory-usage', expect.any(Function));
  });

  it('done 事件触发扫描，done 上补证据不重复触发', async () => {
    const scan = vi.spyOn(scanner, 'scan').mockResolvedValue([]);
    scanner.subscribeToEvents();

    state.statusChangedHandler!({ workunit: { id: 'wu-evidence', status: 'done' }, previousStatus: 'done' });
    state.statusChangedHandler!({ workunit: { id: 'wu-active', status: 'active' } });
    expect(scan).not.toHaveBeenCalled();
    state.statusChangedHandler!({ workunit: snapshot, previousStatus: 'in_review' });
    await vi.waitFor(() => expect(scan).toHaveBeenCalledWith(snapshot));
  });

  it('启动 recoverPending 只续扫 done WU，并隔离单个失败', async () => {
    const active = finalSnapshot({ id: 'wu-active', status: 'active' });
    const failed = finalSnapshot({ id: 'wu-failed' });
    fileStore.listCurrentSnapshots.mockResolvedValue([snapshot, active, failed]);
    const scan = vi.spyOn(scanner, 'scan')
      .mockResolvedValueOnce(['code-review'])
      .mockRejectedValueOnce(new Error('recover failed'));

    await expect(scanner.recoverPending()).resolves.toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls.map(call => call[0].id)).toEqual(['wu-1', 'wu-failed']);
  });
});
