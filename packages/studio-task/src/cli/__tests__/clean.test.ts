// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runClean } from '../clean';

describe('AC-004: clean 命令', () => {
  test('AC-004-1: 正常清理已完成任务', async () => {
    const result = await runClean({ company: '1', days: 7 });
    expect(result.output).toContain('Cleaned');
  });
  test('AC-004-2: json 格式', async () => {
    const result = await runClean({ company: '1', days: 7, format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.cleaned).toBeDefined();
  });
  test('AC-004-3: 无可清理任务提示', async () => {
    const result = await runClean({ company: 'empty', days: 7 });
    expect(result.output).toContain('无可清理');
  });
  test('AC-004-4: 公司不存在错误', async () => {
    const result = await runClean({ company: 'nonexistent', days: 7 });
    expect(result.error).toContain('不存在');
  });
  test('AC-004-5: 无效天数错误', async () => {
    const result = await runClean({ company: '1', days: -1 });
    expect(result.error).toContain('无效');
  });
});