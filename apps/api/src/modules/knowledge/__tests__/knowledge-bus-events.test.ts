/**
 * Behavioral tests for KnowledgeBus event emission (S3 post-gaps, R4 单一路径更新)
 *
 * AC:
 * - recordPattern 被质量门拒绝 → 写 knowledge:quality_gate { skipped: true }
 * - recordPattern 成功 ingest → 写 knowledge:entry_created { entryType, title }
 * - recordPattern triage 门拒绝 → 写 knowledge:quality_gate { skipped: true, reason }
 *
 * R4 收敛后质量门统一为 ingestWithQualityGate（knowledge-singletons.ts）：
 * studio 侧 linter 预检已移除，门禁 = triage 业务门 + harness KnowledgeIngest
 * 内置 audit（reject → __rejected 不入库）。事件经 FileStore.appendJsonl 写
 * studio-events.jsonl（不再是 Prisma studioEvent）。
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockAppendJsonl, mockIngestEntry } = vi.hoisted(() => ({
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
  mockIngestEntry: vi.fn().mockReturnValue({ id: 'entry-1', lastReferenced: null, contributors: ['test'] }),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  FileStore: class {
    appendJsonl = mockAppendJsonl;
  },
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

import { KnowledgeBus } from '../knowledge-bus.service.js';

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

describe('KnowledgeBus event emission', () => {
  test('emits knowledge:quality_gate when harness ingest gate rejects entry (__rejected)', async () => {
    mockIngestEntry.mockReturnValue({ __rejected: true, __rejectReasons: ['Title too short'] });

    const bus = new KnowledgeBus();
    await bus.recordPattern({
      type: 'pattern',
      title: 'bad',
      content: 'x',
      severity: 'info',
      timestamp: Date.now(),
    });

    const event = findEvent('knowledge:quality_gate');
    expect(event).toBeDefined();
    expect(event!.payload.skipped).toBe(true);
    expect(event!.payload.reason).toContain('Title too short');
  });

  test('emits knowledge:entry_created on successful ingest', async () => {
    mockIngestEntry.mockReturnValue({ id: 'new-1', lastReferenced: null, contributors: ['test'] });

    const bus = new KnowledgeBus();
    await bus.recordPattern({
      type: 'pattern',
      title: 'Good pattern',
      content: 'This is a valid entry with enough content',
      severity: 'info',
      timestamp: Date.now(),
    });

    const event = findEvent('knowledge:entry_created');
    expect(event).toBeDefined();
    expect(event!.payload.entryType).toBe('pattern');
    expect(event!.payload.title).toBe('Good pattern');
  });

  test('does not emit entry_created when quality gate rejects', async () => {
    mockIngestEntry.mockReturnValue({ __rejected: true, __rejectReasons: ['Bad content'] });

    const bus = new KnowledgeBus();
    await bus.recordPattern({
      type: 'pattern',
      title: 'rejected',
      content: 'bad',
      severity: 'info',
      timestamp: Date.now(),
    });

    expect(findEvent('knowledge:entry_created')).toBeUndefined();
  });

  test('emits quality_gate for triage gate rejection (missing root_cause)', async () => {
    const bus = new KnowledgeBus();
    await bus.recordPattern({
      type: 'pattern',
      title: 'Triage entry',
      content: 'Agent crashed with unknown error',  // no root_cause or fix_action keywords
      severity: 'info',
      timestamp: Date.now(),
      source: 'triage' as any,
    });

    const event = findEvent('knowledge:quality_gate');
    expect(event).toBeDefined();
    expect(event!.payload.skipped).toBe(true);
    expect(event!.payload.reason).toContain('root_cause');
    // triage 门在 ingest 之前 — 不应调用 ingestEntry
    expect(mockIngestEntry).not.toHaveBeenCalled();
  });
});
