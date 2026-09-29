/**
 * GateCheckerService 降级语义测试
 *
 * studio#644：harness 不可用时的降级行为覆盖——
 * L1/L2 非严格模式跳过（判通过）、L3/L4 或严格模式报错（判失败）。
 * 与 gate-checker.service.test.ts 分开成文件：降级路径要求动态导入
 * `@dommaker/harness` 拿不到 CheckpointValidator，需文件级 mock 隔离。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@dommaker/harness', () => ({
  CheckpointValidator: undefined,
}));

import { gateCheckerService } from './gate-checker.service.js';
import { changeHistoryService } from './change-history.service.js';
import type { SpecContent, ChangeRecord } from '../types/change.types.js';

describe('GateCheckerService harness 不可用降级', () => {
  beforeEach(() => {
    changeHistoryService.clear();
  });

  function saveChange(overrides: Partial<ChangeRecord> & { specId: string; newVersion: SpecContent }): ChangeRecord {
    const record: ChangeRecord = {
      level: 'L3',
      changeTypes: [],
      summary: '',
      status: 'auto_approved',
      submittedBy: 'user-001',
      submittedAt: new Date(),
      oldVersion: { metadata: { id: overrides.specId, title: '', status: 'draft' } },
      ...overrides,
      id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    } as ChangeRecord;
    changeHistoryService.save(record);
    return record;
  }

  const spec: SpecContent = {
    metadata: { id: 'spec-degraded', title: 'Test' },
  };

  it('L1 非严格模式：harness 不可用时跳过并判通过', async () => {
    const change = saveChange({ specId: 'spec-degraded', newVersion: spec, level: 'L1' });

    const result = await gateCheckerService.validate({
      changeId: change.id,
      checkpoints: ['file_exists'],
    });

    const check = result.checks.find(c => c.type === 'file_exists');
    expect(check).toBeDefined();
    expect(check!.passed).toBe(true);
    expect(check!.message).toContain('跳过');
    expect(check!.details).toMatchObject({ skipped: true, reason: 'harness_unavailable' });
    expect(result.passed).toBe(true);
  });

  it('L2 非严格模式：harness 不可用时跳过并判通过', async () => {
    const change = saveChange({ specId: 'spec-degraded', newVersion: spec, level: 'L2' });

    const result = await gateCheckerService.validate({
      changeId: change.id,
      checkpoints: ['command_success'],
    });

    const check = result.checks.find(c => c.type === 'command_success');
    expect(check).toBeDefined();
    expect(check!.passed).toBe(true);
    expect(check!.message).toContain('跳过');
    expect(check!.details).toMatchObject({ skipped: true, reason: 'harness_unavailable' });
  });

  it('L3：harness 不可用时必要检查判失败', async () => {
    const change = saveChange({ specId: 'spec-degraded', newVersion: spec, level: 'L3' });

    const result = await gateCheckerService.validate({
      changeId: change.id,
      checkpoints: ['file_exists'],
    });

    const check = result.checks.find(c => c.type === 'file_exists');
    expect(check).toBeDefined();
    expect(check!.passed).toBe(false);
    expect(check!.message).toContain('Harness 不可用');
    expect(check!.details).toMatchObject({ skipped: false, reason: 'harness_unavailable', level: 'L3' });
    expect(result.passed).toBe(false);
    expect(result.canProceed).toBe(false);
  });

  it('L4：harness 不可用时必要检查判失败', async () => {
    const change = saveChange({ specId: 'spec-degraded', newVersion: spec, level: 'L4' });

    const result = await gateCheckerService.validate({
      changeId: change.id,
      checkpoints: ['output_matches'],
    });

    const check = result.checks.find(c => c.type === 'output_matches');
    expect(check).toBeDefined();
    expect(check!.passed).toBe(false);
    expect(check!.details).toMatchObject({ skipped: false, reason: 'harness_unavailable', level: 'L4' });
  });

  it('L1 + 严格模式：harness 不可用时不允许跳过，判失败', async () => {
    const change = saveChange({ specId: 'spec-degraded', newVersion: spec, level: 'L1' });

    const result = await gateCheckerService.validate({
      changeId: change.id,
      checkpoints: ['file_exists'],
      strictMode: true,
    });

    const check = result.checks.find(c => c.type === 'file_exists');
    expect(check).toBeDefined();
    expect(check!.passed).toBe(false);
    expect(check!.message).toContain('Harness 不可用');
    expect(check!.details).toMatchObject({ skipped: false, reason: 'harness_unavailable' });
  });
});
