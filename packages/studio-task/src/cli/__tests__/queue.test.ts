// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runQueue } from '../queue';

describe('AC-001: queue 命令', () => {
  test('AC-001-1: 正常查询队列', async () => {
    const result = await runQueue({ company: '1' });
    expect(result.output).toContain('Task Queue');
  });
  test('AC-001-2: table 格式', async () => {
    const result = await runQueue({ company: '1', format: 'table' });
    expect(result.output).toContain('ID');
  });
  test('AC-001-3: json 格式', async () => {
    const result = await runQueue({ company: '1', format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.tasks).toBeInstanceOf(Array);
  });
  test('AC-001-4: --status 过滤', async () => {
    const result = await runQueue({ company: '1', status: 'pending' });
    expect(result.output).toContain('pending');
  });
  test('AC-001-5: 无任务返回提示', async () => {
    const result = await runQueue({ company: 'empty' });
    expect(result.output).toContain('无任务');
  });
  test('AC-001-6: 公司不存在错误', async () => {
    const result = await runQueue({ company: 'nonexistent' });
    expect(result.error).toContain('不存在');
  });
});