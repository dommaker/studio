/**
 * Behavioral tests for SignalAggregator
 *
 * AC:
 * - run() groups raw signal entries by tag, counts frequency in 7-day window
 * - Trends generated when ≥3 occurrences in 7 days
 * - Trend entries have tags=[trend-aggregated, <tag>] and consumptionMode=signal
 * - Existing trends are updated, not duplicated
 * - Raw entries with trend-aggregated tag are excluded from aggregation
 * - run() returns 0 on empty signals or no trends meeting threshold
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockList, mockUpdate, mockIngestEntry, mockRecordReference, mockScheduleSync } = vi.hoisted(() => ({
  mockList: vi.fn().mockReturnValue([]),
  mockUpdate: vi.fn(),
  mockIngestEntry: vi.fn().mockReturnValue({ id: 'new-trend-1', lastReferenced: null, contributors: ['test'] }),
  mockRecordReference: vi.fn(),
  mockScheduleSync: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../knowledge-bus.service.js', () => ({
  sharedStore: { list: mockList, update: mockUpdate },
  sharedIngest: { ingestEntry: mockIngestEntry },
  sharedLifecycle: { recordReference: mockRecordReference },
  scheduleVectorDbSync: mockScheduleSync,
}));

import { SignalAggregator } from '../signal-aggregator.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockReturnValue([]);
  mockIngestEntry.mockReturnValue({ id: 'new-trend-1', lastReferenced: null, contributors: ['test'] });
});

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Test entry',
    content: 'content',
    created: new Date().toISOString(),
    tags: ['deploy_timeout'],
    consumptionMode: 'signal',
    ...overrides,
  };
}

describe('SignalAggregator', () => {
  test('returns 0 when no raw signal entries', async () => {
    mockList.mockReturnValue([]);
    const agg = new SignalAggregator();
    const result = await agg.run();
    expect(result).toBe(0);
  });

  test('returns 0 when no trends meet threshold', async () => {
    // Only 2 entries for same tag — below threshold of 3
    mockList.mockReturnValue([
      makeEntry({ tags: ['deploy_timeout'] }),
      makeEntry({ tags: ['deploy_timeout'] }),
    ]);
    const agg = new SignalAggregator();
    const result = await agg.run();
    expect(result).toBe(0);
  });

  test('creates trend when ≥3 entries for same tag in 7 days', async () => {
    const rawEntries = [
      makeEntry({ tags: ['deploy_timeout'] }),
      makeEntry({ tags: ['deploy_timeout'] }),
      makeEntry({ tags: ['deploy_timeout'] }),
    ];
    mockList.mockImplementation((filter: Record<string, unknown>) => {
      if (filter.consumptionModes?.includes('signal')) return rawEntries;
      if (filter.tags?.includes('trend-aggregated')) return [];
      return [];
    });
    const agg = new SignalAggregator();
    const result = await agg.run();
    expect(result).toBe(1);
    expect(mockIngestEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'guideline',
        tags: ['trend-aggregated', 'deploy_timeout'],
      }),
      expect.objectContaining({
        source: 'signal-aggregator',
        layer: 'project',
        consumptionMode: 'signal',
        tags: ['trend-aggregated', 'deploy_timeout'],
      }),
    );
    expect(mockScheduleSync).toHaveBeenCalled();
  });

  test('updates existing trend instead of creating duplicate', async () => {
    const existingTrend = makeEntry({
      id: 'existing-trend-1',
      tags: ['trend-aggregated', 'deploy_timeout'],
    });
    // 3 raw entries + 1 existing trend
    mockList.mockImplementation((filter: Record<string, unknown>) => {
      if (filter.consumptionModes?.includes('signal')) {
        return [
          makeEntry({ tags: ['deploy_timeout'] }),
          makeEntry({ tags: ['deploy_timeout'] }),
          makeEntry({ tags: ['deploy_timeout'] }),
        ];
      }
      if (filter.tags?.includes('trend-aggregated')) {
        return [existingTrend];
      }
      return [];
    });

    const agg = new SignalAggregator();
    const result = await agg.run();
    // Update returns false (not new), so created count = 0
    expect(result).toBe(0);
    expect(mockUpdate).toHaveBeenCalledWith('existing-trend-1', expect.objectContaining({
      content: expect.stringContaining('deploy_timeout'),
    }));
  });

  test('excludes entries with trend-aggregated tag from aggregation', async () => {
    const rawEntries = [
      makeEntry({ tags: ['trend-aggregated', 'deploy_timeout'] }),
      makeEntry({ tags: ['deploy_timeout'] }),
      makeEntry({ tags: ['deploy_timeout'] }),
      makeEntry({ tags: ['deploy_timeout'] }),
    ];
    mockList.mockImplementation((filter: Record<string, unknown>) => {
      if (filter.consumptionModes?.includes('signal')) return rawEntries;
      if (filter.tags?.includes('trend-aggregated')) return [];
      return [];
    });
    const agg = new SignalAggregator();
    const result = await agg.run();
    // Only 3 raw entries (excluding trend-aggregated), meets threshold
    expect(result).toBe(1);
  });

  test('groups by first meaningful tag', async () => {
    const rawEntries = [
      makeEntry({ tags: ['deploy_timeout', 'other_tag'] }),
      makeEntry({ tags: ['deploy_timeout'] }),
      makeEntry({ tags: ['deploy_timeout'] }),
      makeEntry({ tags: ['test_failure'] }),
      makeEntry({ tags: ['test_failure'] }),
      makeEntry({ tags: ['test_failure'] }),
    ];
    mockList.mockImplementation((filter: Record<string, unknown>) => {
      if (filter.consumptionModes?.includes('signal')) return rawEntries;
      if (filter.tags?.includes('trend-aggregated')) return [];
      return [];
    });
    const agg = new SignalAggregator();
    const result = await agg.run();
    expect(result).toBe(2); // Both deploy_timeout and test_failure meet threshold
  });

  test('skips generic tags (low_quality, design-doc)', async () => {
    const rawEntries = [
      makeEntry({ tags: ['low_quality', 'deploy_timeout'] }),
      makeEntry({ tags: ['low_quality', 'deploy_timeout'] }),
      makeEntry({ tags: ['low_quality', 'deploy_timeout'] }),
    ];
    mockList.mockImplementation((filter: Record<string, unknown>) => {
      if (filter.consumptionModes?.includes('signal')) return rawEntries;
      if (filter.tags?.includes('trend-aggregated')) return [];
      return [];
    });
    const agg = new SignalAggregator();
    const result = await agg.run();
    // First meaningful tag is deploy_timeout, meets threshold
    expect(result).toBe(1);
    expect(mockIngestEntry).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['trend-aggregated', 'deploy_timeout'] }),
      expect.anything(),
    );
  });

  test('ignores entries older than 7 days', async () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    mockList.mockReturnValue([
      makeEntry({ tags: ['deploy_timeout'], created: oldDate }),
      makeEntry({ tags: ['deploy_timeout'], created: oldDate }),
      makeEntry({ tags: ['deploy_timeout'] }), // only 1 recent
    ]);
    const agg = new SignalAggregator();
    const result = await agg.run();
    expect(result).toBe(0); // Only 1 in window, below threshold
  });

  test('returns 0 and logs on error', async () => {
    mockList.mockImplementation(() => { throw new Error('store error'); });
    const agg = new SignalAggregator();
    const result = await agg.run();
    expect(result).toBe(0);
  });
});
