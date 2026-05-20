// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runLog } from '../log';

describe('AC-001: log 命令', () => {
  test('AC-001-1: 正常查询审计日志', async () => {
    const result = await runLog({ company: '1' });
    expect(result.output).toContain('Audit Logs');
    expect(result.output).toContain('create');
  });

  test('AC-001-2: table 格式输出', async () => {
    const result = await runLog({ company: '1', format: 'table' });
    expect(result.output).toContain('ID');
    expect(result.output).toContain('Action');
  });

  test('AC-001-3: json 格式输出', async () => {
    const result = await runLog({ company: '1', format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.logs).toBeInstanceOf(Array);
    expect(data.total).toBeDefined();
  });

  test('AC-001-4: --action 过滤', async () => {
    const result = await runLog({ company: '1', action: 'create' });
    expect(result.output).toContain('create');
  });

  test('AC-001-5: --limit 限制条数', async () => {
    const result = await runLog({ company: '1', limit: 2 });
    const lines = result.output.split('\n').filter(l => l.includes('|'));
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  test('AC-001-6: 公司不存在返回错误', async () => {
    const result = await runLog({ company: 'nonexistent' });
    expect(result.error).toContain('不存在');
  });
});