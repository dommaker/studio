// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runStats } from '../stats';

describe('AC-005: stats 命令', () => {
  test('AC-005-1: 正常输出统计', async () => {
    const result = await runStats({ company: '1' });
    expect(result.output).toContain('Total');
    expect(result.output).toContain('L1');
  });

  test('AC-005-2: table 格式输出', async () => {
    const result = await runStats({ company: '1', format: 'table' });
    expect(result.output).toContain('Active');
    expect(result.output).toContain('Inactive');
  });

  test('AC-005-3: json 格式输出', async () => {
    const result = await runStats({ company: '1', format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.total).toBeDefined();
    expect(data.byLevel).toBeDefined();
  });

  test('AC-005-4: 空公司返回空统计', async () => {
    const result = await runStats({ company: 'empty' });
    expect(result.output).toContain('Total: 0');
  });

  test('AC-005-5: 无效公司返回错误', async () => {
    const result = await runStats({ company: 'invalid' });
    expect(result.error).toBeTruthy();
  });
});