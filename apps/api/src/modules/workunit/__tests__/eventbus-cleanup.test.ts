/**
 * AC: ac-eventbus-cleanup
 *
 * Source-code verification:
 * - workunit-events.ts and cycle-detection.ts deleted
 * - workunit 服务层（#672 拆分四文件）无 emit/cycle/unlockDependents 引用
 *   （架构精简刀6：workunit.service.ts 门面删除，扫描目标改为拆分层四文件）
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WORKUNIT_DIR = path.resolve(__dirname, '..');
const SERVICE_LAYER = ['workunit-crud.ts', 'workunit-query.ts', 'workunit-lifecycle.ts', 'workunit-review.ts']
  .map(f => fs.readFileSync(path.join(WORKUNIT_DIR, f), 'utf-8')).join('\n');

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

  it('服务层无 workunit-events import', () => {
    const content = SERVICE_LAYER;
    expect(content).not.toMatch(/workunit-events/);
  });

  it('服务层无 cycle-detection import', () => {
    const content = SERVICE_LAYER;
    expect(content).not.toMatch(/cycle-detection/);
  });

  it('服务层无 emit function calls', () => {
    const content = SERVICE_LAYER;
    expect(content).not.toMatch(/emit(WorkUnit|workunit)/);
  });

  it('服务层无 unlockDependents method', () => {
    const content = SERVICE_LAYER;
    expect(content).not.toMatch(/unlockDependents/);
  });

  it('服务层无 getExistingEdges method', () => {
    const content = SERVICE_LAYER;
    expect(content).not.toMatch(/getExistingEdges/);
  });

  it('服务层无 validateNoCycle call', () => {
    const content = SERVICE_LAYER;
    expect(content).not.toMatch(/validateNoCycle/);
  });
});
