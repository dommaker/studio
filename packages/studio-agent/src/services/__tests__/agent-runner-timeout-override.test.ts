/**
 * P3: executeLightweight respects task.timeoutMs override
 *
 * Source-code verification:
 * - execSh timeoutMs uses task.timeoutMs when available
 * - Falls back to getSessionTimeout(tier) * 60 * 1000 when not set
 * - AgentTask interface includes optional timeoutMs field
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const agentRunnerSrc = fs.readFileSync(
  path.resolve(__dirname, '../agent-runner.ts'),
  'utf-8',
);

const sessionManagerSrc = fs.readFileSync(
  path.resolve(__dirname, '../session-manager.ts'),
  'utf-8',
);

describe('AgentTask interface', () => {
  test('includes optional timeoutMs field', () => {
    expect(sessionManagerSrc).toMatch(/timeoutMs\?\s*:\s*number/);
  });
});

describe('executeLightweight timeout resolution', () => {
  test('execSh timeoutMs references task.timeoutMs', () => {
    // After fix: timeoutMs should use task.timeoutMs when available
    expect(agentRunnerSrc).toMatch(/task\.timeoutMs/);
  });

  test('falls back to getSessionTimeout when task.timeoutMs not set', () => {
    // The fallback pattern: task.timeoutMs ?? getSessionTimeout(...) * 60 * 1000
    expect(agentRunnerSrc).toMatch(/task\.timeoutMs\s*\?\?/);
  });
});
