// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { formatOutput, formatTable, formatJson, formatCsv } from '../formatter';

/**
 * AC-002: 输出格式化支持 table/json/csv
 * 
 * 测试覆盖：
 * - 正常情况：三种格式输出
 * - 边界情况：空数据、单行数据
 * - 错误情况：无效格式
 */
describe('AC-002: 输出格式化', () => {
  const testData = [
    { id: 1, name: 'Alice', role: 'Admin' },
    { id: 2, name: 'Bob', role: 'User' },
  ];

  describe('正常情况', () => {
    test('AC-002-1: table 格式输出', () => {
      const result = formatOutput(testData, { format: 'table' });
      expect(result).toContain('id');
      expect(result).toContain('name');
      expect(result).toContain('role');
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
    });

    test('AC-002-2: json 格式输出', () => {
      const result = formatOutput(testData, { format: 'json' });
      const parsed = JSON.parse(result);
      expect(parsed).toEqual(testData);
    });

    test('AC-002-3: csv 格式输出', () => {
      const result = formatOutput(testData, { format: 'csv' });
      expect(result).toContain('id,name,role');
      expect(result).toContain('1,Alice,Admin');
      expect(result).toContain('2,Bob,User');
    });

    test('AC-002-4: 指定 headers', () => {
      const result = formatOutput(testData, {
        format: 'table',
        headers: ['id', 'name'],
      });
      expect(result).toContain('id');
      expect(result).toContain('name');
      expect(result).not.toContain('role');
    });
  });

  describe('边界情况', () => {
    test('AC-002-5: 空数据输出', () => {
      const result = formatOutput([], { format: 'table' });
      expect(result).toBe('(no data)');
    });

    test('AC-002-6: 空数据 json 格式', () => {
      const result = formatOutput([], { format: 'json' });
      expect(result).toBe('[]');
    });

    test('AC-002-7: 空数据 csv 格式', () => {
      const result = formatOutput([], { format: 'csv' });
      expect(result).toBe('');
    });

    test('AC-002-8: 单行数据', () => {
      const singleData = [{ id: 1, name: 'Alice' }];
      const result = formatOutput(singleData, { format: 'table' });
      expect(result).toContain('Alice');
    });

    test('AC-002-9: 无表头（csv 格式）', () => {
      const result = formatOutput(testData, { format: 'csv', noHeader: true });
      expect(result).not.toContain('id,name,role');
      expect(result).toContain('1,Alice,Admin');
    });
  });

  describe('错误情况', () => {
    test('AC-002-10: 无效格式抛出错误', () => {
      expect(() => formatOutput(testData, { format: 'invalid' as any })).toThrow();
    });

    test('AC-002-11: headers 与数据字段不匹配', () => {
      const result = formatOutput(testData, {
        format: 'table',
        headers: ['id', 'unknown'],
      });
      // 未知字段显示为空或 undefined
      expect(result).toBeDefined();
    });
  });
});

describe('formatTable', () => {
  test('生成表格格式', () => {
    const data = [{ a: 1, b: 2 }];
    const result = formatTable(data);
    expect(result).toContain('a');
    expect(result).toContain('b');
  });
});

describe('formatJson', () => {
  test('生成 JSON 格式', () => {
    const data = [{ a: 1 }];
    const result = formatJson(data);
    expect(JSON.parse(result)).toEqual(data);
  });

  test('JSON 格式美化输出', () => {
    const data = [{ a: 1, b: { c: 2 } }];
    const result = formatJson(data);
    expect(result).toContain('\n'); // 多行美化
  });
});

describe('formatCsv', () => {
  test('生成 CSV 格式', () => {
    const data = [{ a: 1, b: 2 }];
    const result = formatCsv(data);
    expect(result).toBe('a,b\n1,2');
  });

  test('CSV 特殊字符处理（逗号）', () => {
    const data = [{ name: 'Alice, Bob' }];
    const result = formatCsv(data);
    expect(result).toContain('"Alice, Bob"'); // 引号包裹
  });

  test('CSV 特殊字符处理（引号）', () => {
    const data = [{ name: 'Alice "Bob"' }];
    const result = formatCsv(data);
    expect(result).toContain('"Alice ""Bob""'); // 双引号转义
  });
});