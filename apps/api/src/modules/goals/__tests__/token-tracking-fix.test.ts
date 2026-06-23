/**
 * Token tracking bug fix verification (source-code analysis pattern)
 *
 * AC:
 * 1. scheduler-dispatch.ts failure path guards against model='unknown' (not just truthy)
 * 2. session-manager.ts uses extractUsage/parseStreamEvents on .agent.log (not parseClaudeUsage on outputText)
 * 3. metrics.ts recordAgentSessionFromLog uses parseStreamEvents (not JSON.parse on raw multi-line)
 * 4. parseClaudeUsage is NOT called with result.outputText in session-manager
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function readSource(relativePath: string): string {
  const fullPath = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', relativePath);
  return fs.readFileSync(fullPath, 'utf-8');
}

describe('token tracking bug fixes', () => {
  test('scheduler-dispatch.ts failure path model guard excludes "unknown"', () => {
    const src = readSource('apps/api/src/modules/goals/scheduler-dispatch.ts');

    // Find the line that uses failTokens.model for the failure-path recordExecution
    const lines = src.split('\n');
    const failModelLine = lines.find(l => l.includes('model:') && l.includes('failTokens.model')) || '';
    expect(failModelLine).toBeTruthy();

    // The fix: must check !== 'unknown', not just truthy ||
    expect(failModelLine).toContain("!== 'unknown'");
    // Must NOT use simple || for failTokens.model fallback
    expect(failModelLine).not.toMatch(/failTokens\.model\s*\|\|/);
  });

  test('session-manager.ts uses extractUsage on .agent.log (not parseClaudeUsage on outputText)', () => {
    const src = readSource('apps/api/src/daemon/session-manager.ts');

    // Must NOT call parseClaudeUsage with result.outputText
    expect(src).not.toMatch(/parseClaudeUsage\s*\(\s*result\.outputText/);

    // Must use extractUsage or parseStreamEvents for usage parsing
    expect(src).toMatch(/extractUsage|parseStreamEvents/);

    // Must read .agent.log for usage
    expect(src).toMatch(/\.agent\.log/);
  });

  test('metrics.ts recordAgentSessionFromLog uses parseStreamEvents (not JSON.parse on raw)', () => {
    const src = readSource('apps/api/src/daemon/metrics.ts');

    // Find the recordAgentSessionFromLog function body
    const funcMatch = src.match(/export function recordAgentSessionFromLog[\s\S]*?\n\}/);
    expect(funcMatch).toBeTruthy();
    const funcBody = funcMatch![0];

    // Must NOT use JSON.parse on raw log content
    expect(funcBody).not.toMatch(/JSON\.parse\s*\(\s*raw\s*\)/);

    // Must use parseStreamEvents
    expect(funcBody).toMatch(/parseStreamEvents/);

    // Must use extractUsage
    expect(funcBody).toMatch(/extractUsage/);
  });

  test('session-manager.ts imports extractUsage or parseStreamEvents from shared', () => {
    const src = readSource('apps/api/src/daemon/session-manager.ts');

    // Must import from @dommaker/studio-shared (or have them available)
    const importLines = src.split('\n').filter(l => l.includes('import'));
    const hasSharedImport = importLines.some(l =>
      l.includes('@dommaker/studio-shared') &&
      (l.includes('extractUsage') || l.includes('parseStreamEvents'))
    );
    expect(hasSharedImport).toBe(true);
  });

  test('metrics.ts imports parseStreamEvents and extractUsage from shared', () => {
    const src = readSource('apps/api/src/daemon/metrics.ts');

    const importLines = src.split('\n').filter(l => l.includes('import'));
    const hasSharedImport = importLines.some(l =>
      l.includes('@dommaker/studio-shared') &&
      l.includes('parseStreamEvents') && l.includes('extractUsage')
    );
    expect(hasSharedImport).toBe(true);
  });
});
