// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runDemote } from '../demote';

describe('AC-004: demote 命令', () => {
  test('AC-004-1: 正常降级角色', async () => {
    const result = await runDemote({ role: '3', reason: 'performance issue' });
    expect(result.output).toContain('demoted');
    expect(result.output).toContain('L2');
  });

  test('AC-004-2: 显示降级原因', async () => {
    const result = await runDemote({ role: '3', reason: 'test reason' });
    expect(result.output).toContain('test reason');
  });

  test('AC-004-3: 未提供原因返回错误', async () => {
    const result = await runDemote({ role: '3', reason: '' });
    expect(result.error).toContain('原因');
  });

  test('AC-004-4: 已是最低级返回错误', async () => {
    const result = await runDemote({ role: 'min-level', reason: 'test' });
    expect(result.error).toContain('最低级');
  });

  test('AC-004-5: 角色不存在返回错误', async () => {
    const result = await runDemote({ role: 'nonexistent', reason: 'test' });
    expect(result.error).toContain('不存在');
  });
});