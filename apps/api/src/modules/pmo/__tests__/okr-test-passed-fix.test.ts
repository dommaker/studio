/**
 * B59-004: testPassed must reflect real test results from .progress.json
 *
 * Previously testPassed was only set in goal-lifecycle.ts summary as
 * successCount === totalSessions (session success rate, NOT test results).
 *
 * Fix: scheduler-dispatch reads .progress.json testResults in both
 * handleDispatchSuccess and handleDispatchFailure.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DISPATCH_PATH = path.resolve(__dirname, '../../goals/scheduler-dispatch.ts');
const source = fs.readFileSync(DISPATCH_PATH, 'utf-8');

describe('testPassed reads from .progress.json (B59-004)', () => {
  it('imports fs module for reading progress files', () => {
    expect(source).toMatch(/import\s+\*\s+as\s+fs\s+from\s+['"]node:fs['"]/);
  });

  it('handleDispatchSuccess reads .progress.json for testResults', () => {
    // Find the success handler function
    const successMatch = source.match(
      /async\s+function\s+handleDispatchSuccess[\s\S]*?(?=\nasync\s+function\s+|\nexport\s+function\s+|\n\/\/\s*──)/,
    );
    expect(successMatch).toBeTruthy();
    const body = successMatch![0];
    expect(body).toContain('.progress.json');
    expect(body).toContain('testPassed');
    expect(body).toContain('testResults');
  });

  it('handleDispatchFailure reads .progress.json for testResults (with fallback)', () => {
    const failMatch = source.match(
      /async\s+function\s+handleDispatchFailure[\s\S]*?(?=\nasync\s+function\s+|\nexport\s+function\s+|\n\/\/\s*──)/,
    );
    expect(failMatch).toBeTruthy();
    const body = failMatch![0];
    expect(body).toContain('.progress.json');
    expect(body).toContain('testPassed');
  });
});
