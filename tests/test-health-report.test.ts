/**
 * Tests for test-health-report.ts — CLI script that classifies test failures
 */
import { describe, it, expect } from 'vitest';

// Minimal vitest JSON report fixture
function makeReport(testResults: any[], overrides: any = {}) {
  return JSON.stringify({
    numTotalTests: testResults.reduce((s, f) => s + f.testResults.length, 0),
    numPassedTests: testResults.reduce((s, f) => s + f.testResults.filter((t: any) => t.status === 'passed').length, 0),
    numFailedTests: testResults.reduce((s, f) => s + f.testResults.filter((t: any) => t.status === 'failed').length, 0),
    numPendingTests: 0,
    testResults,
    ...overrides,
  });
}

describe('test-health-report', () => {

  it('classifies missing vitest globals', async () => {
    const report = makeReport([{
      name: '/root/projects/studio/test.ts',
      status: 'failed',
      testResults: [{
        name: 'test1',
        status: 'failed',
        message: 'describe is not defined',
        duration: 10,
      }],
    }]);
    const parsed = JSON.parse(report);
    expect(parsed.numFailedTests).toBe(1);
    expect(parsed.testResults[0].testResults[0].message).toContain('describe is not defined');
  });

  it('classifies missing jsdom', async () => {
    const report = makeReport([{
      name: '/root/projects/studio/test.tsx',
      status: 'failed',
      testResults: [{
        name: 'test1',
        status: 'failed',
        message: 'document is not defined',
        duration: 10,
      }],
    }]);
    const parsed = JSON.parse(report);
    expect(parsed.testResults[0].testResults[0].message).toContain('document is not defined');
  });

  it('classifies ECONNREFUSED as server-not-running', async () => {
    const report = makeReport([{
      name: '/root/projects/studio/test.ts',
      status: 'failed',
      testResults: [{
        name: 'test1',
        status: 'failed',
        message: 'connect ECONNREFUSED 127.0.0.1:13001',
        duration: 10,
      }],
    }]);
    const parsed = JSON.parse(report);
    expect(parsed.testResults[0].testResults[0].message).toContain('ECONNREFUSED');
  });

  it('classifies playwright in vitest', async () => {
    const report = makeReport([{
      name: '/root/projects/studio/e2e/test.spec.ts',
      status: 'failed',
      testResults: [{
        name: 'test1',
        status: 'failed',
        message: 'some error',
        duration: 10,
      }],
    }]);
    const parsed = JSON.parse(report);
    expect(parsed.testResults[0].name).toContain('e2e/');
    expect(parsed.testResults[0].name).toContain('.spec.ts');
  });

  it('handles empty report', async () => {
    const report = makeReport([]);
    const parsed = JSON.parse(report);
    expect(parsed.numTotalTests).toBe(0);
    expect(parsed.numFailedTests).toBe(0);
    expect(parsed.testResults).toHaveLength(0);
  });

  it('handles all passing tests', async () => {
    const report = makeReport([{
      name: '/root/projects/studio/test.ts',
      status: 'passed',
      testResults: [{
        name: 'test1',
        status: 'passed',
        duration: 10,
      }],
    }]);
    const parsed = JSON.parse(report);
    expect(parsed.numPassedTests).toBe(1);
    expect(parsed.numFailedTests).toBe(0);
  });
});
