// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runExport } from '../export';

describe('AC-002: export 命令', () => {
  test('AC-002-1: 正常导出日志', async () => {
    const result = await runExport({ company: '1', from: '2026-01-01', to: '2026-03-31' });
    expect(result.output).toContain('Exported');
    expect(result.output).toContain('audit');
  });

  test('AC-002-2: csv 格式输出', async () => {
    const result = await runExport({ company: '1', from: '2026-01-01', to: '2026-03-31', format: 'csv' });
    expect(result.output).toContain('ID,Company,Action');
    expect(result.output).toContain('2026-01');
  });

  test('AC-002-3: json 格式输出', async () => {
    const result = await runExport({ company: '1', from: '2026-01-01', to: '2026-03-31', format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.exported).toBeDefined();
    expect(data.logs).toBeInstanceOf(Array);
  });

  test('AC-002-4: 日期范围过滤', async () => {
    const result = await runExport({ company: '1', from: '2026-02-01', to: '2026-02-28' });
    expect(result.output).toContain('Exported');
  });

  test('AC-002-5: 无日志返回提示', async () => {
    const result = await runExport({ company: 'empty', from: '2026-01-01', to: '2026-03-31' });
    expect(result.output).toContain('无审计日志');
  });

  test('AC-002-6: 无效日期返回错误', async () => {
    const result = await runExport({ company: '1', from: 'invalid', to: '2026-03-31' });
    expect(result.error).toContain('无效日期');
  });
});