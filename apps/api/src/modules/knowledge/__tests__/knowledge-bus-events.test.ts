/**
 * Behavioral tests for KnowledgeBus event emission (S3 post-gaps)
 *
 * AC:
 * - recordPattern rejected by quality gate → emits knowledge:quality_gate { skipped: true }
 * - recordPattern successful ingest → emits knowledge:entry_created { entryType, title }
 * - recordPattern triage gate rejection → emits knowledge:quality_gate { skipped: true, reason }
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockStudioEventCreate, mockValidateEntry, mockIngestEntry } = vi.hoisted(() => ({
  mockStudioEventCreate: vi.fn().mockResolvedValue({ id: 'evt-1' }),
  mockValidateEntry: vi.fn().mockReturnValue([]),
  mockIngestEntry: vi.fn().mockReturnValue({ id: 'entry-1', lastReferenced: null, contributors: ['test'] }),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    studioEvent: { create: mockStudioEventCreate },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@dommaker/harness', () => {
  class KnowledgeLinter {
    validateEntry = mockValidateEntry;
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

// Mock child_process.exec (used by scheduleVectorDbSync)
vi.mock('child_process', () => ({ exec: vi.fn() }));

import { KnowledgeBus } from '../knowledge-bus.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockStudioEventCreate.mockResolvedValue({ id: 'evt-1' });
  mockValidateEntry.mockReturnValue([]);
  mockIngestEntry.mockReturnValue({ id: 'entry-1', lastReferenced: null, contributors: ['test'] });
});

describe('KnowledgeBus event emission', () => {
  test('emits knowledge:quality_gate when quality gate rejects entry', async () => {
    mockValidateEntry.mockReturnValue([
      { severity: 'high', description: 'Title too short' },
    ]);

    const bus = new KnowledgeBus();
    await bus.recordPattern({
      type: 'pattern',
      title: 'bad',
      content: 'x',
      severity: 'info',
      timestamp: Date.now(),
    });

    // Should emit quality_gate event with skipped=true
    const qualityGateCall = mockStudioEventCreate.mock.calls.find(
      (c: any[]) => c[0].data.type === 'knowledge:quality_gate',
    );
    expect(qualityGateCall).toBeDefined();
    const payload = JSON.parse(qualityGateCall[0].data.payload);
    expect(payload.skipped).toBe(true);
    expect(payload.reason).toContain('Title too short');
  });

  test('emits knowledge:entry_created on successful ingest', async () => {
    mockValidateEntry.mockReturnValue([]); // no blockers
    mockIngestEntry.mockReturnValue({ id: 'new-1', lastReferenced: null, contributors: ['test'] });

    const bus = new KnowledgeBus();
    await bus.recordPattern({
      type: 'pattern',
      title: 'Good pattern',
      content: 'This is a valid entry with enough content',
      severity: 'info',
      timestamp: Date.now(),
    });

    const entryCreatedCall = mockStudioEventCreate.mock.calls.find(
      (c: any[]) => c[0].data.type === 'knowledge:entry_created',
    );
    expect(entryCreatedCall).toBeDefined();
    const payload = JSON.parse(entryCreatedCall[0].data.payload);
    expect(payload.entryType).toBe('pattern');
    expect(payload.title).toBe('Good pattern');
  });

  test('does not emit entry_created when quality gate rejects', async () => {
    mockValidateEntry.mockReturnValue([
      { severity: 'high', description: 'Bad content' },
    ]);

    const bus = new KnowledgeBus();
    await bus.recordPattern({
      type: 'pattern',
      title: 'rejected',
      content: 'bad',
      severity: 'info',
      timestamp: Date.now(),
    });

    const entryCreatedCall = mockStudioEventCreate.mock.calls.find(
      (c: any[]) => c[0].data.type === 'knowledge:entry_created',
    );
    expect(entryCreatedCall).toBeUndefined();
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

    const qualityGateCall = mockStudioEventCreate.mock.calls.find(
      (c: any[]) => c[0].data.type === 'knowledge:quality_gate',
    );
    expect(qualityGateCall).toBeDefined();
    const payload = JSON.parse(qualityGateCall[0].data.payload);
    expect(payload.skipped).toBe(true);
    expect(payload.reason).toContain('root_cause');
  });
});
