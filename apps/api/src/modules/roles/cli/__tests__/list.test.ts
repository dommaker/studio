// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runList } from '../list';

describe('AC-001: list 命令', () => {
  test('AC-001-1: 正常列出角色', async () => {
    const result = await runList({ company: '1' });
    expect(result.output).toContain('角色');
  });

  test('AC-001-2: table 格式输出', async () => {
    const result = await runList({ company: '1', format: 'table' });
    expect(result.output).toContain('ID');
    expect(result.output).toContain('Name');
  });

  test('AC-001-3: json 格式输出', async () => {
    const result = await runList({ company: '1', format: 'json' });
    expect(JSON.parse(result.output)).toBeInstanceOf(Array);
  });

  test('AC-001-4: 按级别过滤', async () => {
    const result = await runList({ company: '1', level: 'L2' });
    expect(result.output).toContain('L2');
  });

  test('AC-001-5: 空列表返回提示', async () => {
    const result = await runList({ company: 'empty' });
    expect(result.output).toContain('无角色');
  });

  test('AC-001-6: 无效公司返回错误', async () => {
    const result = await runList({ company: 'invalid' });
    expect(result.error).toBeTruthy();
  });
});