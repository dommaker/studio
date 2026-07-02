/**
 * AC: ac-agent-runner-home
 *
 * Source-code verification:
 * - HOME path uses /tmp/agent-loop/${workUnitId} pattern
 * - Falls back to executionId when workUnitId not provided
 * - STUDIO_WORKUNIT_ID env var injected when workUnitId present
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const agentRunnerSrc = fs.readFileSync(
  path.resolve(__dirname, '../agent-runner.ts'),
  'utf-8',
);

describe('agent-runner HOME path', () => {
  test('HOME uses /tmp/agent-loop/ prefix (not /tmp/execution-)', () => {
    // New: HOME should use /tmp/agent-loop/ pattern
    expect(agentRunnerSrc).toMatch(/\/tmp\/agent-loop\//);
    // Old pattern should be gone
    expect(agentRunnerSrc).not.toMatch(/\/tmp\/execution-/);
  });

  test('HOME path uses workUnitId from task.parameters', () => {
    // workUnitId should be extracted from task.parameters
    expect(agentRunnerSrc).toMatch(/task\.parameters\?\.workUnitId/);
  });

  test('falls back to executionId when workUnitId not provided', () => {
    // Fallback pattern: workUnitId ?? task.executionId (or similar)
    expect(agentRunnerSrc).toMatch(/workUnitId.*task\.executionId|executionId.*workUnitId/s);
  });

  test('STUDIO_WORKUNIT_ID env var injected when workUnitId present', () => {
    expect(agentRunnerSrc).toMatch(/STUDIO_WORKUNIT_ID/);
  });
});
