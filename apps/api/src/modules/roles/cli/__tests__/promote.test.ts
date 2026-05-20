// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runPromote } from '../promote';

describe('AC-003: promote 命令', () => {
  test('AC-003-1: 正常晋升角色', async () => {
    const result = await runPromote({ role: '1', confirm: true });
    expect(result.output).toContain('promoted');
    expect(result.output).toContain('L3');
  });

  test('AC-003-2: 显示新级别信息', async () => {
    const result = await runPromote({ role: '1', confirm: true });
    expect(result.output).toContain('salary');
    expect(result.output).toContain('capability limit');
  });

  test('AC-003-3: 未确认返回提示', async () => {
    const result = await runPromote({ role: '1', confirm: false });
    expect(result.output).toContain('确认');
  });

  test('AC-003-4: 已达最高级返回错误', async () => {
    const result = await runPromote({ role: 'max-level', confirm: true });
    expect(result.error).toContain('最高级');
  });

  test('AC-003-5: 角色不存在返回错误', async () => {
    const result = await runPromote({ role: 'nonexistent', confirm: true });
    expect(result.error).toContain('不存在');
  });
});