// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runShow } from '../show';

describe('AC-002: show 命令', () => {
  test('AC-002-1: 正常显示角色详情', async () => {
    const result = await runShow({ role: '1' });
    expect(result.output).toContain('Role');
    expect(result.output).toContain('L2');  // 级别信息在 Role 行
  });

  test('AC-002-2: table 格式输出', async () => {
    const result = await runShow({ role: '1', format: 'table' });
    expect(result.output).toContain('Performance');
  });

  test('AC-002-3: json 格式输出', async () => {
    const result = await runShow({ role: '1', format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.id).toBe('1');
    expect(data.performance).toBeDefined();
  });

  test('AC-002-4: 角色不存在返回错误', async () => {
    const result = await runShow({ role: 'nonexistent' });
    expect(result.error).toContain('不存在');
  });

  test('AC-002-5: 显示性能统计', async () => {
    const result = await runShow({ role: '1' });
    expect(result.output).toContain('tasks');
    expect(result.output).toContain('quality');
  });
});