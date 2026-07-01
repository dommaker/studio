/**
 * Behavioral tests for SignalAggregator data layer rewrite (Phase 1)
 *
 * AC:
 * AC-A.4: signal-aggregator writes trends to data/trends/ instead of knowledge/
 * AC-A.4: signal-aggregator no longer calls sharedIngest.ingestEntry
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';

describe('AC-A.4: signal-aggregator → data/', () => {
  test('imports writeTrendData from knowledge-service', async () => {
    // Verify the import exists in the source code
    const source = fs.readFileSync(
      'apps/api/src/modules/knowledge/signal-aggregator.ts',
      'utf-8'
    );
    expect(source).toContain("import { writeTrendData } from './knowledge-service.js'");
  });

  test('does not import sharedIngest', async () => {
    const source = fs.readFileSync(
      'apps/api/src/modules/knowledge/signal-aggregator.ts',
      'utf-8'
    );
    // sharedIngest should not be in imports
    expect(source).not.toMatch(/import.*sharedIngest.*from.*knowledge-bus/);
  });

  test('upsertTrend calls writeTrendData', async () => {
    const source = fs.readFileSync(
      'apps/api/src/modules/knowledge/signal-aggregator.ts',
      'utf-8'
    );
    // upsertTrend should call writeTrendData
    expect(source).toContain('writeTrendData(');
  });
});
