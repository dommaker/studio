// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runRun } from '../run';

describe('AC-002: run 命令', () => {
  test('AC-002-1: 正常执行任务', async () => {
    const result = await runRun({ task: '1' });
    expect(result.output).toContain('Executed');
  });
  test('AC-002-2: json 格式', async () => {
    const result = await runRun({ task: 'pending-task', format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.status).toBe('completed');
  });
  test('AC-002-3: 任务不存在错误', async () => {
    const result = await runRun({ task: 'nonexistent' });
    expect(result.error).toContain('不存在');
  });
  test('AC-002-4: 已完成任务提示', async () => {
    const result = await runRun({ task: 'completed' });
    expect(result.output).toContain('已完成');
  });
  test('AC-002-5: 运行中任务提示', async () => {
    const result = await runRun({ task: 'running' });
    expect(result.output).toContain('运行中');
  });
});