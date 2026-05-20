// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runRetry } from '../retry';

describe('AC-003: retry 命令', () => {
  test('AC-003-1: 正常重试失败任务', async () => {
    const result = await runRetry({ task: 'failed' });
    expect(result.output).toContain('Retrying');
  });
  test('AC-003-2: json 格式', async () => {
    const result = await runRetry({ task: 'failed-task', format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.status).toBe('pending');
  });
  test('AC-003-3: 任务不存在错误', async () => {
    const result = await runRetry({ task: 'nonexistent' });
    expect(result.error).toContain('不存在');
  });
  test('AC-003-4: 非失败任务错误', async () => {
    const result = await runRetry({ task: 'completed' });
    expect(result.error).toContain('只有失败任务');
  });
  test('AC-003-5: 成功任务提示', async () => {
    const result = await runRetry({ task: '1' });
    expect(result.output).toContain('成功');
  });
});