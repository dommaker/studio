/**
 * 质量门事件行为测试（S3 post-gaps，R4 单一路径更新；#343 起 KnowledgeBus 删除，
 * 直接测唯一入口 ingestWithQualityGate——knowledge-singletons.ts）
 *
 * AC:
 * - harness ingest 门拒绝 → 写 knowledge:quality_gate { skipped: true }
 * - 成功 ingest → 写 knowledge:entry_created { entryType, title }
 * - triage 业务门拒绝 → 写 knowledge:quality_gate { skipped: true, reason }
 *
 * 门禁 = triage 业务门 + harness KnowledgeIngest 内置 audit（reject → __rejected
 * 不入库）。事件经 FileStore.appendJsonl 写 studio-events.jsonl。
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockAppendJsonl, mockIngestEntry, mockEventBusPublish } = vi.hoisted(() => ({
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
  mockIngestEntry: vi.fn().mockReturnValue({ id: 'entry-1', lastReferenced: null, contributors: ['test'] }),
  mockEventBusPublish: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  FileStore: class {
    appendJsonl = mockAppendJsonl;
  },
  eventBus: { publish: mockEventBusPublish, subscribe: vi.fn(), unsubscribe: vi.fn() },
  // #361 薄壳转发后 knowledge-singletons 经 utils/studio-log-path re-export 取用；
  // 模块加载期即调用，partial mock 必须提供
  resolveStudioLogFile: (name: string) => `/tmp/test-studio-logs/${name}`,
}));

vi.mock('@dommaker/harness', () => {
  class KnowledgeLinter {
    validateEntry = vi.fn().mockReturnValue([]);
  }
  class KnowledgeIngest {
    ingestEntry = mockIngestEntry;
  }
  class FileKnowledgeStore {
    list = vi.fn().mockReturnValue([]);
  }
  class KnowledgeLifecycle {}
  class KnowledgeQuery {}
  class KnowledgeInjector {}
  class ReferenceTracker {}
  return { FileKnowledgeStore, KnowledgeLifecycle, KnowledgeIngest, KnowledgeQuery, KnowledgeInjector, KnowledgeLinter, ReferenceTracker };
});

// scheduleVectorDbSync / startup pkill 不真正起进程
vi.mock('child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));

import { ingestWithQualityGate } from '../knowledge-singletons.js';

function findEvent(type: string) {
  const call = mockAppendJsonl.mock.calls.find((c: any[]) => c[1]?.type === type);
  if (!call) return undefined;
  return { ...call[1], payload: JSON.parse(call[1].payload) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendJsonl.mockResolvedValue(undefined);
  mockIngestEntry.mockReturnValue({ id: 'entry-1', lastReferenced: null, contributors: ['test'] });
});

describe('ingestWithQualityGate event emission', () => {
  test('emits knowledge:quality_gate when harness ingest gate rejects entry (__rejected)', () => {
    mockIngestEntry.mockReturnValue({ __rejected: true, __rejectReasons: ['Title too short'] });

    const saved = ingestWithQualityGate(
      { ingest: { ingestEntry: mockIngestEntry } as any },
      { type: 'guideline', title: 'bad', content: 'x', tags: ['pattern'], source: 'monitor', entryType: 'pattern' },
    );

    expect(saved).toBeNull();
    const event = findEvent('knowledge:quality_gate');
    expect(event).toBeDefined();
    expect(event!.payload.skipped).toBe(true);
    expect(event!.payload.reason).toContain('Title too short');
  });

  test('emits knowledge:entry_created on successful ingest', () => {
    mockIngestEntry.mockReturnValue({ id: 'new-1', lastReferenced: null, contributors: ['test'] });

    const saved = ingestWithQualityGate(
      { ingest: { ingestEntry: mockIngestEntry } as any },
      { type: 'guideline', title: 'Good pattern', content: 'This is a valid entry with enough content', tags: ['pattern'], source: 'monitor', entryType: 'pattern' },
    );

    expect(saved).not.toBeNull();
    const event = findEvent('knowledge:entry_created');
    expect(event).toBeDefined();
    expect(event!.payload.entryType).toBe('pattern');
    expect(event!.payload.title).toBe('Good pattern');
  });

  test('does not emit entry_created when quality gate rejects', () => {
    mockIngestEntry.mockReturnValue({ __rejected: true, __rejectReasons: ['Bad content'] });

    ingestWithQualityGate(
      { ingest: { ingestEntry: mockIngestEntry } as any },
      { type: 'guideline', title: 'rejected', content: 'bad', tags: ['pattern'], source: 'monitor', entryType: 'pattern' },
    );

    expect(findEvent('knowledge:entry_created')).toBeUndefined();
  });

  test('emits quality_gate for triage gate rejection (missing root_cause), before touching ingest', () => {
    const saved = ingestWithQualityGate(
      { ingest: { ingestEntry: mockIngestEntry } as any },
      { type: 'guideline', title: 'Triage entry', content: 'Agent crashed with unknown error', tags: ['pattern'], source: 'triage', entryType: 'pattern' },
    );

    expect(saved).toBeNull();
    const event = findEvent('knowledge:quality_gate');
    expect(event).toBeDefined();
    expect(event!.payload.skipped).toBe(true);
    expect(event!.payload.reason).toContain('root_cause');
    // triage 门在 ingest 之前 — 不应调用 ingestEntry
    expect(mockIngestEntry).not.toHaveBeenCalled();
  });
});

describe('ingestWithQualityGate SSE 广播（Step 2：knowledge.entry_changed → KnowledgePage 重拉信号）', () => {
  test('成功 ingest → eventBus 广播 knowledge.entry_changed（action=created + 元信息）', () => {
    mockIngestEntry.mockReturnValue({ id: 'new-1', lastReferenced: null, contributors: ['test'] });

    ingestWithQualityGate(
      { ingest: { ingestEntry: mockIngestEntry } as any },
      { type: 'guideline', title: 'Good pattern', content: 'valid content', tags: ['pattern'], source: 'monitor', entryType: 'pattern' },
    );

    expect(mockEventBusPublish).toHaveBeenCalledWith('events', expect.objectContaining({
      event_type: 'knowledge.entry_changed',
      data: { action: 'created', entryId: 'new-1', entryType: 'pattern', title: 'Good pattern' },
    }));
  });

  test('质量门拒绝 → 不广播', () => {
    mockIngestEntry.mockReturnValue({ __rejected: true, __rejectReasons: ['Bad content'] });

    ingestWithQualityGate(
      { ingest: { ingestEntry: mockIngestEntry } as any },
      { type: 'guideline', title: 'rejected', content: 'bad', tags: ['pattern'], source: 'monitor', entryType: 'pattern' },
    );

    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });

  test('eventBus.publish 抛异常 → best-effort，ingest 主流程不受影响', () => {
    mockIngestEntry.mockReturnValue({ id: 'new-2', lastReferenced: null, contributors: ['test'] });
    mockEventBusPublish.mockImplementation(() => { throw new Error('subscriber boom'); });

    const saved = ingestWithQualityGate(
      { ingest: { ingestEntry: mockIngestEntry } as any },
      { type: 'guideline', title: 'Good pattern', content: 'valid content', tags: ['pattern'], source: 'monitor', entryType: 'pattern' },
    );

    expect(saved).toMatchObject({ id: 'new-2' });
  });
});
