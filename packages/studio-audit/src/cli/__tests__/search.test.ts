// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runSearch } from '../search';

describe('AC-003: search 命令', () => {
  test('AC-003-1: 正常搜索日志', async () => {
    const result = await runSearch({ company: '1', query: 'role' });
    expect(result.output).toContain('Search Results');
    expect(result.output).toContain('role');
  });

  test('AC-003-2: table 格式输出', async () => {
    const result = await runSearch({ company: '1', query: 'create', format: 'table' });
    expect(result.output).toContain('ID');
    expect(result.output).toContain('Details');
  });

  test('AC-003-3: json 格式输出', async () => {
    const result = await runSearch({ company: '1', query: 'task', format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.results).toBeInstanceOf(Array);
    expect(data.query).toBe('task');
  });

  test('AC-003-4: 无结果返回提示', async () => {
    const result = await runSearch({ company: '1', query: 'nonexistent-term' });
    expect(result.output).toContain('无匹配');
  });

  test('AC-003-5: 空查询返回错误', async () => {
    const result = await runSearch({ company: '1', query: '' });
    expect(result.error).toContain('查询内容');
  });
});