/**
 * AC: ac-eventbus-cleanup
 *
 * Source-code verification:
 * - workunit-events.ts and cycle-detection.ts deleted
 * - workunit.service.ts has no emit/cycle/unlockDependents references
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WORKUNIT_DIR = path.resolve(__dirname, '..');

describe('EventBus cleanup verification', () => {
  it('workunit-events.ts is deleted', () => {
    expect(fs.existsSync(path.join(WORKUNIT_DIR, 'workunit-events.ts'))).toBe(false);
  });

  it('cycle-detection.ts is deleted', () => {
    expect(fs.existsSync(path.join(WORKUNIT_DIR, 'cycle-detection.ts'))).toBe(false);
  });

  it('workunit-events.test.ts is deleted', () => {
    expect(fs.existsSync(path.join(WORKUNIT_DIR, '__tests__/workunit-events.test.ts'))).toBe(false);
  });

  it('cycle-detection.test.ts is deleted', () => {
    expect(fs.existsSync(path.join(WORKUNIT_DIR, '__tests__/cycle-detection.test.ts'))).toBe(false);
  });

  it('workunit.service.ts has no workunit-events import', () => {
    const content = fs.readFileSync(path.join(WORKUNIT_DIR, 'workunit.service.ts'), 'utf-8');
    expect(content).not.toMatch(/workunit-events/);
  });

  it('workunit.service.ts has no cycle-detection import', () => {
    const content = fs.readFileSync(path.join(WORKUNIT_DIR, 'workunit.service.ts'), 'utf-8');
    expect(content).not.toMatch(/cycle-detection/);
  });

  it('workunit.service.ts has no emit function calls', () => {
    const content = fs.readFileSync(path.join(WORKUNIT_DIR, 'workunit.service.ts'), 'utf-8');
    expect(content).not.toMatch(/emit(WorkUnit|workunit)/);
  });

  it('workunit.service.ts has no unlockDependents method', () => {
    const content = fs.readFileSync(path.join(WORKUNIT_DIR, 'workunit.service.ts'), 'utf-8');
    expect(content).not.toMatch(/unlockDependents/);
  });

  it('workunit.service.ts has no getExistingEdges method', () => {
    const content = fs.readFileSync(path.join(WORKUNIT_DIR, 'workunit.service.ts'), 'utf-8');
    expect(content).not.toMatch(/getExistingEdges/);
  });

  it('workunit.service.ts has no validateNoCycle call', () => {
    const content = fs.readFileSync(path.join(WORKUNIT_DIR, 'workunit.service.ts'), 'utf-8');
    expect(content).not.toMatch(/validateNoCycle/);
  });
});
