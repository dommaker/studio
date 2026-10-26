import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHarnessValidate } = vi.hoisted(() => ({ mockHarnessValidate: vi.fn() }));
vi.mock('@dommaker/harness', () => ({
  CheckpointValidator: class {
    validate = mockHarnessValidate;
  },
}));

import { gateCheckerService } from '../gate-checker.service.js';
import { changeHistoryService } from '../change-history.service.js';
import type { ChangeRecord } from '../types/change.types.js';

function saveChange(): ChangeRecord {
  const record = {
    id: 'security-change',
    specId: 'security-spec',
    level: 'L3',
    changeTypes: [],
    summary: '',
    status: 'pending',
    submittedBy: 'tester',
    submittedAt: new Date(),
    oldVersion: { metadata: { id: 'security-spec', title: 'Old' } },
    newVersion: { metadata: { id: 'security-spec', title: 'New' } },
  } as ChangeRecord;
  changeHistoryService.save(record);
  return record;
}

describe('GateChecker 宿主执行边界', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    changeHistoryService.clear();
    mockHarnessValidate.mockResolvedValue({ passed: true, message: 'ok', checks: [] });
  });

  it('命令与调用方 workdir 在 Harness 前硬拒绝', async () => {
    const change = saveChange();
    for (const input of [
      { checkpoints: ['command_success'], harnessConfigs: [{ type: 'command_success', harness: { command: 'custom-command' } }] },
      { checkpoints: ['output_matches'], harnessConfigs: [{ type: 'output_matches', harness: { pattern: '^ok', command: 'custom-command' } }] },
      { checkpoints: ['file_exists'], harnessConfigs: [{ type: 'file_exists', harness: { path: 'package.json', workdir: '/tmp' } }] },
    ]) {
      await expect(gateCheckerService.validate({ changeId: change.id, ...input } as never)).rejects.toThrow(/不接受/);
    }
    expect(mockHarnessValidate).not.toHaveBeenCalled();
  });

  it('文件路径越界时不调用 Harness，也不产生文件读取副作用', async () => {
    const change = saveChange();
    const result = await gateCheckerService.validate({
      changeId: change.id,
      checkpoints: ['file_contains'],
      harnessConfigs: [{ type: 'file_contains', harness: { path: '../outside', content: 'secret' } }],
      strictMode: true,
    });

    expect(result.passed).toBe(false);
    expect(result.checks[0].message).toContain('项目根');
    expect(mockHarnessValidate).not.toHaveBeenCalled();
  });

  it('合法文件检查使用固定项目根与解析后的受控路径', async () => {
    const change = saveChange();
    const result = await gateCheckerService.validate({
      changeId: change.id,
      checkpoints: ['file_exists'],
      harnessConfigs: [{ type: 'file_exists', harness: { path: 'package.json' } }],
      strictMode: true,
    });

    expect(result.passed).toBe(true);
    expect(mockHarnessValidate).toHaveBeenCalledTimes(1);
    const [checkpoint, context] = mockHarnessValidate.mock.calls[0];
    expect(context.projectPath).toBe(process.cwd());
    expect(context.workdir).toBe(process.cwd());
    expect(checkpoint.checks[0].config.path).toBe(`${process.cwd()}/package.json`);
  });
});
