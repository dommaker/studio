// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runList } from '../list';

describe('AC-002: list 命令', () => {
  test('AC-002-1: 正常查询通知列表', async () => {
    const result = await runList({ user: '1' });
    expect(result.output).toContain('Notifications');
    expect(result.output).toContain('test notification');
  });

  test('AC-002-2: table 格式输出', async () => {
    const result = await runList({ user: '1', format: 'table' });
    expect(result.output).toContain('ID');
    expect(result.output).toContain('Type');
  });

  test('AC-002-3: json 格式输出', async () => {
    const result = await runList({ user: '1', format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.notifications).toBeInstanceOf(Array);
    expect(data.total).toBeDefined();
  });

  test('AC-002-4: --unread 只显示未读', async () => {
    const result = await runList({ user: '1', unread: true });
    expect(result.output).toContain('unread');
  });

  test('AC-002-5: 无通知返回提示', async () => {
    const result = await runList({ user: 'empty' });
    expect(result.output).toContain('无通知');
  });

  test('AC-002-6: 用户不存在返回错误', async () => {
    const result = await runList({ user: 'nonexistent' });
    expect(result.error).toContain('不存在');
  });
});